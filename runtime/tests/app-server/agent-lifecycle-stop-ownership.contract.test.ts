import { setImmediate } from "node:timers/promises";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { AgenCDaemonSnapshotPolicyRegistry } from "../../src/app-server/daemon-cli.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import type { AgenCBackgroundAgentTerminalSnapshot } from "../../src/app-server/background-agent-runner.js";

const timestamp = "2026-09-10T00:00:00.000Z";

describe("daemon agent stop ownership", () => {
  it.skipIf(process.platform === "win32")("keeps snapshot handles through Stop during an active turn, then closes them", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-stop-fd-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-stop-fd-cwd-"));
    mkdirSync(join(cwd, ".git"));
    const registry = new AgenCDaemonSnapshotPolicyRegistry({
      agencHome: home, defaultCwd: cwd, onError: (error) => { throw error; },
    });
    const baseline = readdirSync("/dev/fd").length;
    const entered = Promise.withResolvers<void>();
    const finishTurn = Promise.withResolvers<void>();
    const terminal: AgenCBackgroundAgentTerminalSnapshot = {
      openedAt: timestamp, epoch: 1, eventId: "stop-terminal",
      rolloutPath: join(cwd, "stop-rollout.jsonl"),
      result: {
        runId: "stop-run", status: "cancelled", exitCode: null,
        stopReason: "operator", finalMessage: null, usage: null,
        lastSequence: null, finishedAt: timestamp,
      },
    };
    const sessions = new AgenCDaemonSessionManager();
    let manager!: AgenCDaemonAgentManager;
    manager = new AgenCDaemonAgentManager({
      agencHome: home,
      sessionManager: sessions,
      runner: {
        startAgent: vi.fn(),
        stopAgent: async () => {
          entered.resolve();
          await finishTurn.promise;
          await manager.handleRunnerTerminated("stop-run", {
            status: "stopped", lastActiveAt: timestamp, terminal,
          });
        },
      },
      recordRunTerminal: (record) => registry.recordRunTerminal(record),
      recordAgentStatusTransition: (transition) => registry.recordAgentStatusTransition(transition),
      terminateSession: async (params) => {
        try { await sessions.terminateSession(params); }
        finally { registry.releaseSession(params.sessionId); }
      },
    });
    try {
      registry.recordAgentRun({
        id: "stop-run", objective: "active turn", status: "running",
        startedAt: timestamp, lastActiveAt: timestamp,
        currentSessionId: "stop-run", cwd,
      });
      await sessions.restoreSession({ sessionId: "stop-run", agentId: "stop-run" });
      await manager.restoreAgent({
        agentId: "stop-run", objective: "active turn",
        sessionIds: ["stop-run"], runtimeAvailable: true,
      });
      const stopping = manager.stopAgent({ agentId: "stop-run", reason: "operator" });
      await entered.promise;
      expect((await sessions.getSession("stop-run")).status).not.toBe("closed");
      finishTurn.resolve();
      await stopping;
      expect(readdirSync("/dev/fd").length).toBeLessThanOrEqual(baseline + 2);
      const driver = openStateDatabases({ cwd, agencHome: home });
      try {
        const row = driver.prepareState<[string], { tool_state_json: string }>(
          `SELECT tool_state_json FROM session_state_snapshots WHERE session_id = ?
           ORDER BY snapshot_at DESC LIMIT 1`,
        ).get("stop-run");
        expect(JSON.parse(row!.tool_state_json).statusTransitions).toEqual(
          expect.arrayContaining([expect.objectContaining({ status: "stopped" })]),
        );
      } finally { driver.close(); }
    } finally {
      finishTurn.resolve();
      registry.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(["agent.stop", "daemon shutdown"] as const)(
    "%s waits for the existing teardown owner", async (operation) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const stopAgent = vi.fn(async () => {
        entered.resolve();
        await release.promise;
      });
      const manager = new AgenCDaemonAgentManager({
        runner: { startAgent: vi.fn(), stopAgent },
      });
      await manager.restoreAgent({ agentId: "agent", objective: "stop", runtimeAvailable: true });
      const first = manager.stopAgent({ agentId: "agent", reason: "first reason" });
      await entered.promise;
      let completed = false;
      const second = (operation === "agent.stop"
        ? manager.stopAgent({ agentId: "agent", reason: "second reason" })
        : manager.stopAll()).then((result) => {
          completed = true;
          return result;
        });
      try {
        await setImmediate();
        expect(completed).toBe(false);
        expect(stopAgent).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await Promise.all([first, second]);
      }
      expect(await first).toEqual({ agentId: "agent", stopped: true });
      if (operation === "agent.stop") expect(await second).toEqual(await first);
      expect(stopAgent).toHaveBeenCalledOnce();
      expect(stopAgent).toHaveBeenCalledWith("agent", "first reason");
    },
  );

  it.each([false, true])(
    "projects explicit-stop canonical evidence and closes sessions (projection failure: %s)",
    async (failProjection) => {
      const order: string[] = [];
      const terminal: AgenCBackgroundAgentTerminalSnapshot = {
        openedAt: timestamp,
        epoch: 1,
        eventId: "run-terminal:agent:1",
        rolloutPath: "/tmp/agent.jsonl",
        result: {
          runId: "agent", status: "cancelled", exitCode: null,
          stopReason: "operator", finalMessage: null, usage: null,
          lastSequence: 2, finishedAt: timestamp,
        },
      };
      const sessions = new AgenCDaemonSessionManager({
        onSessionTerminated: () => { order.push("session_closed"); },
      });
      await sessions.restoreSession({ sessionId: "session", agentId: "agent" });
      const recordRunTerminal = vi.fn(async () => {
        order.push("canonical_projection");
        if (failProjection) throw new Error("terminal projection failed");
      });
      const manager = new AgenCDaemonAgentManager({
        sessionManager: sessions,
        runner: {
          startAgent: vi.fn(),
          stopAgent: async () => {
            order.push("canonical_terminal");
            await manager.handleRunnerTerminated("agent", {
              status: "stopped", lastActiveAt: timestamp, terminal,
            });
          },
        },
        recordRunTerminal,
        recordAgentStatusTransition: (transition) => { order.push(transition.status); },
      });
      await manager.restoreAgent({
        agentId: "agent", objective: "stop", sessionIds: ["session"], runtimeAvailable: true,
      });
      const stopped = manager.stopAgent({ agentId: "agent", reason: "operator" });
      if (failProjection) {
        await expect(stopped).rejects.toThrow("terminal projection failed");
        expect(order).not.toContain("stopped");
        expect(order).not.toContain("error");
      } else {
        await expect(stopped).resolves.toEqual({ agentId: "agent", stopped: true });
        expect(order.indexOf("canonical_projection")).toBeLessThan(order.indexOf("stopped"));
      }
      expect(recordRunTerminal).toHaveBeenCalledExactlyOnceWith({
        agentId: "agent", sessionId: "agent", ...terminal,
      });
      expect(order).toContain("session_closed");
      await expect(sessions.getSession("session")).resolves.toMatchObject({ status: "closed" });
    },
  );
});
