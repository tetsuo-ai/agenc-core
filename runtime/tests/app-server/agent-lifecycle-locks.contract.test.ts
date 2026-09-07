import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import type { AgenCBackgroundAgentSnapshot } from "../../src/app-server/background-agent-runner.js";

const timestamp = "2026-09-07T00:00:00.000Z";

describe("daemon lifecycle lock boundaries", () => {
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
