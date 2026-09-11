import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import type { AgenCBackgroundAgentTerminalSnapshot } from "../../src/app-server/background-agent-runner.js";

const timestamp = "2026-09-10T00:00:00.000Z";

describe("daemon agent stop ownership", () => {
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
