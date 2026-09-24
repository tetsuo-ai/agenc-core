import { describe, expect, it } from "vitest";
import { notifyPluginProcessIdle, releasePluginProcess, reservePluginProcess } from "./plugin-process-budget.js";

describe("plugin process budget", () => {
  it("rechecks eviction when a declined eviction becomes idle before the waiter subscribes", async () => {
    const first = {}; const second = {};
    let busy = false;
    let evictions = 0;
    const evict = async (): Promise<void> => {
      evictions++;
      if (busy) {
        busy = false;
        notifyPluginProcessIdle();
      } else {
        releasePluginProcess(first);
      }
    };
    await reservePluginProcess(first, 1, () => busy, evict);
    try {
      // The queued eviction sees a concurrent call. That call finishes and
      // notifies the budget before the eviction promise settles.
      const secondWait = reservePluginProcess(second, 1, () => false, async () => undefined);
      busy = true;
      const completed = await Promise.race([
        secondWait.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 80)),
      ]);
      expect(completed).toBe(true);
      expect(evictions).toBe(2);
      await secondWait;
    } finally {
      releasePluginProcess(first);
      releasePluginProcess(second);
    }
  });

  it("does not retry a slot that stays idle and reserved after a declined eviction", async () => {
    const first = {}; const second = {};
    let evictions = 0;
    await reservePluginProcess(first, 1, () => false, async () => {
      if (++evictions > 8) throw new Error("budget spun on a declined eviction");
      notifyPluginProcessIdle();
    });
    const controller = new AbortController();
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; controller.abort(new Error("budget deadline")); }, 25);
    try {
      await expect(reservePluginProcess(second, 1, () => false, async () => undefined, controller.signal))
        .rejects.toThrow("budget deadline");
      expect(timerFired).toBe(true);
      expect(evictions).toBe(1);
    } finally {
      clearTimeout(timer);
      releasePluginProcess(first);
      releasePluginProcess(second);
    }
  });
});
