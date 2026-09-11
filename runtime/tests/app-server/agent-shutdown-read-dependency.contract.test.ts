import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { settleWithinMicrotasks } from "../helpers/controlled-async.js";

describe("daemon shutdown execution ownership", () => {
  it.each(["cancel", "suspend_idle"] as const)(
    "reaches %s teardown while an existing snapshot waits for that teardown", async (disposition) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const getAgentSnapshot = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return { status: "running" as const, lastActiveAt: "2026-09-11T00:00:00.000Z" };
      });
      const stopAgent = vi.fn(async () => { release.resolve(); });
      const suspendIdleAgentForDaemonShutdown = vi.fn(async () => {
        release.resolve();
        return { disposition: "cancelled" as const };
      });
      const manager = new AgenCDaemonAgentManager({
        runner: { startAgent: vi.fn(), getAgentSnapshot, stopAgent, suspendIdleAgentForDaemonShutdown },
      });
      await manager.restoreAgent({
        agentId: "agent", objective: "held settings read", runtimeAvailable: true,
      });
      const reading = manager.getAgent("agent");
      await entered.promise;
      const stopping = manager.stopAll("daemon_shutdown", { disposition });
      try {
        await expect(settleWithinMicrotasks(stopping)).resolves.toMatchObject({
          status: "fulfilled", value: 1,
        });
        expect(getAgentSnapshot).toHaveBeenCalledOnce();
        expect(disposition === "cancel" ? stopAgent : suspendIdleAgentForDaemonShutdown)
          .toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await Promise.all([reading, stopping]);
      }
      await expect(manager.getAgent("agent")).resolves.toMatchObject({ status: "stopped" });
    },
  );
});
