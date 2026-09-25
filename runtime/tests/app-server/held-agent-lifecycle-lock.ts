import { vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AsyncLock } from "../../src/utils/async-lock.js";

/** Hold the manager's private lifecycle #state.with for transport scheduling tests. */
export async function holdAgentLifecycleLock(): Promise<{
  readonly manager: AgenCDaemonAgentManager;
  release(): Promise<void>;
}> {
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
  await entered.promise;
  return {
    manager,
    async release() {
      release.resolve();
      await pending;
      spy.mockRestore();
    },
  };
}
