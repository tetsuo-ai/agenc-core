import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import type { AgenCBackgroundAgentSnapshot } from "../../src/app-server/background-agent-runner.js";
import { AsyncLock } from "../../src/utils/async-lock.js";

const timestamp = "2026-09-07T00:00:00.000Z";

describe("daemon lifecycle lock boundaries", () => {
  it("projects an agent-id alias synchronously while the lifecycle state lock is held", async () => {
    const manager = new AgenCDaemonAgentManager({
      runner: {
        startAgent: async () => { throw new Error("unexpected start"); },
        getAgentPermissionMode: async () => "default",
      },
    });
    await manager.restoreAgent({ agentId: "agent-a", objective: "chat", sessionIds: ["session-a"] });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalWith = AsyncLock.prototype.with;
    let hold = true;
    const spy = vi.spyOn(AsyncLock.prototype, "with").mockImplementation(function (fn) {
      return originalWith.call(this, async (value) => {
        if (hold && value !== null && typeof value === "object" &&
            "agents" in value && value.agents instanceof Map && value.agents.has("agent-a")) {
          hold = false;
          entered.resolve();
          await release.promise;
        }
        return fn(value);
      });
    });
    const pending = manager.getLiveSessionPermission("agent-a").catch(() => undefined);
    try {
      await entered.promise;
      expect(manager.peekRoutineSessionId("agent-a")).toBe("session-a");
      expect(manager.peekRoutineSessionId("session-a")).toBe("session-a");
    } finally {
      release.resolve();
      await pending;
      spy.mockRestore();
    }
  });

  it.each(["stopAgent", "stopAll"] as const)(
    "%s still tears down a runner whose snapshot hangs",
    async (method) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const stopAgent = vi.fn(async () => {});
      const manager = new AgenCDaemonAgentManager({
        runner: {
          startAgent: async () => {
            throw new Error("unexpected start");
          },
          stopAgent,
          getAgentSnapshot: async () => {
            entered.resolve();
            await release.promise;
            return { status: "running", lastActiveAt: timestamp };
          },
        },
      });
      await manager.restoreAgent({
        agentId: "stalled-snapshot",
        objective: "stop me",
        runtimeAvailable: true,
      });
      if (method === "stopAll") {
        await manager.restoreAgent({
          agentId: "second-agent",
          objective: "stop me too",
          runtimeAvailable: true,
        });
      }
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stopping = (
        method === "stopAgent"
          ? manager.stopAgent({ agentId: "stalled-snapshot" })
          : manager.stopAll()
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        if (method === "stopAgent") {
          await entered.promise;
          await vi.advanceTimersByTimeAsync(30_000);
        } else {
          // Global shutdown owns every retained runner and must reach it
          // without first waiting for diagnostic snapshot availability.
          await setImmediate();
        }
        expect(stopAgent).toHaveBeenCalledWith(
          "stalled-snapshot",
          expect.any(String),
        );
        if (method === "stopAll") {
          expect(stopAgent).toHaveBeenCalledWith("second-agent", "daemon_shutdown");
        }
        expect(await stopping).toBeUndefined();
        expect(await manager.getAgent("stalled-snapshot")).toMatchObject({
          status: "stopped",
        });
      } finally {
        release.resolve();
        await stopping;
        vi.useRealTimers();
      }
    },
  );
  it.each(["session lookup", "status persistence"] as const)(
    "keeps unrelated agents readable during a blocked %s",
    async (operation) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const sessions = new AgenCDaemonSessionManager();
      vi.spyOn(sessions, "getSession").mockImplementation(async () => {
        if (operation === "session lookup") {
          entered.resolve();
          await release.promise;
        }
        return null;
      });
      const manager = new AgenCDaemonAgentManager({
        sessionManager: sessions,
        runner: {
          startAgent: async () => {
            throw new Error("unexpected agent start");
          },
          getAgentSnapshot: async (id) =>
            id === "blocked"
              ? { status: "idle", lastActiveAt: timestamp }
              : null,
        },
        recordAgentStatusTransition: async () => {
          if (operation === "status persistence") {
            entered.resolve();
            await release.promise;
          }
        },
      });
      await manager.restoreAgent({
        agentId: "blocked",
        objective: "blocked agent",
        sessionIds: ["session"],
      });
      await manager.restoreAgent({
        agentId: "other",
        objective: "other agent",
      });
      const blocked =
        operation === "session lookup"
          ? manager.listAgents()
          : manager.getAgent("blocked");
      await entered.promise;
      let completed = false;
      const other = manager.getAgent("other").then((result) => {
        completed = true;
        return result;
      });
      try {
        await setImmediate();
        expect(completed).toBe(true);
        expect(await other).toMatchObject({ agentId: "other" });
      } finally {
        release.resolve();
        await Promise.all([blocked, other]);
      }
    },
  );

  it("keeps a late runner snapshot from replacing a terminal transition", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<AgenCBackgroundAgentSnapshot>();
    const manager = new AgenCDaemonAgentManager({
      runner: {
        startAgent: async () => {
          throw new Error("unexpected agent start");
        },
        getAgentSnapshot: async () => {
          entered.resolve();
          return release.promise;
        },
      },
    });
    await manager.restoreAgent({
      agentId: "agent",
      objective: "pending snapshot",
    });
    const lookup = manager.getAgent("agent");
    await entered.promise;
    let terminated = false;
    const terminal = manager
      .handleRunnerTerminated("agent", {
        status: "stopped",
        lastActiveAt: timestamp,
      })
      .then(() => {
        terminated = true;
      });
    try {
      await setImmediate();
      expect(terminated).toBe(true);
    } finally {
      release.resolve({ status: "running", lastActiveAt: timestamp });
      await Promise.all([lookup, terminal]);
    }
    expect(await manager.getAgent("agent")).toMatchObject({
      status: "stopped",
    });
  });
});
