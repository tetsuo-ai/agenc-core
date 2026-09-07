import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { AgenCBackgroundAgentStartResult } from "../../src/app-server/background-agent-runner.js";

const params = {
  objective: "deadline test",
  cwd: process.cwd(),
  runtimeOptions: resolveAgentRuntimeOptions({}),
};
const started: AgenCBackgroundAgentStartResult = {
  agentId: "late-agent",
  status: "running",
  startedAt: "2026-09-07T00:00:00.000Z",
};

describe("daemon agent creation deadlines", () => {
  it.each(["cancel", "deadline"] as const)(
    "settles stalled agent.create through JSON-RPC on %s",
    async (kind) => {
      const entered = Promise.withResolvers<AbortSignal | undefined>();
      const release = Promise.withResolvers<AgenCBackgroundAgentStartResult>();
      const manager = new AgenCDaemonAgentManager({
        runner: {
          startAgent: async (request) => {
            entered.resolve(request.signal);
            return release.promise;
          },
          stopAgent: async () => {},
        },
      });
      const connection = new AgenCDaemonJsonRpcDispatcher({
        agentManager: manager,
      }).createConnection();
      await connection.dispatch({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "1.0.0",
          clientName: "create-cancellation-test",
        },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const creating = connection.dispatch({
        jsonrpc: "2.0",
        id: "creating",
        method: "agent.create",
        params,
      });
      const signal = await entered.promise;
      try {
        if (kind === "cancel") {
          expect(
            await connection.dispatch({
              jsonrpc: "2.0",
              id: "cancel",
              method: "request.cancel",
              params: { requestId: "creating", reason: "user stop" },
            }),
          ).toMatchObject({ result: { cancelled: true } });
        } else {
          await vi.advanceTimersByTimeAsync(120_000);
        }
        expect(signal?.aborted).toBe(true);
        expect(await creating).toMatchObject({
          error: {
            data:
              kind === "cancel"
                ? { code: "REQUEST_CANCELLED", reason: "user stop" }
                : {
                    code: "DAEMON_OPERATION_TIMEOUT",
                    operation: "agent.create",
                    timeoutMs: 120_000,
                  },
          },
        });
      } finally {
        vi.useRealTimers();
        release.resolve(started);
        await manager.stopAll();
      }
    },
  );
  it.each(["cancel", "deadline"] as const)(
    "rejects a stalled create on %s and retires its late result",
    async (kind) => {
      const entered = Promise.withResolvers<AbortSignal | undefined>();
      const release = Promise.withResolvers<AgenCBackgroundAgentStartResult>();
      const stopAgent = vi.fn(async () => {});
      const recordAgentRun = vi.fn();
      const manager = new AgenCDaemonAgentManager({
        recordAgentRun,
        runner: {
          stopAgent,
          startAgent: async (request) => {
            entered.resolve(request.signal);
            return release.promise;
          },
        },
      });
      const controller = new AbortController();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const outcome = manager
        .createAgent(params, { signal: controller.signal })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      try {
        const signal = await entered.promise;
        if (kind === "cancel") controller.abort(new Error("caller cancelled"));
        else await vi.advanceTimersByTimeAsync(120_000);
        expect(signal?.aborted).toBe(true);
        expect(await outcome).toMatchObject(
          kind === "cancel"
            ? { message: "caller cancelled" }
            : { name: "DaemonOperationTimeoutError" },
        );
        release.resolve(started);
        await vi.advanceTimersByTimeAsync(0);
        expect(stopAgent).toHaveBeenCalledWith(
          "late-agent",
          expect.stringContaining("rollback"),
        );
        expect(recordAgentRun).not.toHaveBeenCalled();
        expect((await manager.listAgents()).agents).toEqual([]);
      } finally {
        release.resolve(started);
        await outcome;
        vi.useRealTimers();
      }
    },
  );

  it("bounds shutdown's create drain and still stops an existing agent", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<AgenCBackgroundAgentStartResult>();
    const stopAgent = vi.fn(async () => {});
    const manager = new AgenCDaemonAgentManager({
      runner: {
        stopAgent,
        startAgent: async () => {
          entered.resolve();
          return release.promise;
        },
      },
    });
    await manager.restoreAgent({
      agentId: "existing",
      objective: "existing",
      runtimeAvailable: true,
    });
    const creating = manager
      .createAgent(params)
      .catch((error: unknown) => error);
    await entered.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = manager.stopAll().catch((error: unknown) => error);
    try {
      expect(await creating).toMatchObject({
        code: "INVALID_ARGUMENT",
        message: "agent.start cancelled because the daemon is shutting down",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await stopping).toBeInstanceOf(AggregateError);
      expect(stopAgent).toHaveBeenCalledWith("existing", "daemon_shutdown");
      release.resolve(started);
      await vi.advanceTimersByTimeAsync(0);
      expect(stopAgent).toHaveBeenCalledWith("late-agent", "daemon_shutdown");
      expect((await manager.listAgents()).agents).toEqual([]);
    } finally {
      release.resolve(started);
      await Promise.all([creating, stopping]);
      vi.useRealTimers();
    }
  });

  it("stops an unpublished runner while session creation is stuck, then cleans its late session", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const sessions = new AgenCDaemonSessionManager();
    const createSession = sessions.createSession.bind(sessions);
    vi.spyOn(sessions, "createSession").mockImplementation(async (request) => {
      entered.resolve();
      await release.promise;
      return createSession(request);
    });
    const terminateSession = vi.spyOn(sessions, "terminateSession");
    const stopAgent = vi.fn(async () => {
      stopped.resolve();
    });
    const recordAgentRun = vi.fn();
    const manager = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      recordAgentRun,
      runner: { startAgent: async () => started, stopAgent },
    });
    const controller = new AbortController();
    const creating = manager
      .createAgent(params, { signal: controller.signal })
      .catch((error: unknown) => error);
    await entered.promise;
    try {
      controller.abort(new Error("caller cancelled"));
      expect(await creating).toMatchObject({ message: "caller cancelled" });
      await stopped.promise;
      expect(stopAgent).toHaveBeenCalledTimes(1);
      expect(recordAgentRun).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      // stopAll waits for the late projection rollback, without starting it a second time.
      await manager.stopAll();
    }
    expect(terminateSession).toHaveBeenCalledOnce();
    expect(stopAgent).toHaveBeenCalledOnce();
    expect((await manager.listAgents()).agents).toEqual([]);
  });
});
