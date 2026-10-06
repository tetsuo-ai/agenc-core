import { describe, expect, it } from "vitest";
import { notifyPluginProcessBusy, notifyPluginProcessIdle, releasePluginProcess, reservePluginProcess } from "./plugin-process-budget.js";

describe("plugin process budget", () => {
  it("rechecks eviction when a declined eviction becomes idle before the waiter subscribes", async () => {
    const first = {}; const second = {};
    let busy = false;
    let evictions = 0;
    const evict = async (): Promise<"busy" | void> => {
      evictions++;
      if (busy) {
        busy = false;
        notifyPluginProcessIdle(first);
        return "busy";
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
      notifyPluginProcessBusy(first);
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

  it("ends promptly when an idle eviction permanently refuses to release its slot", async () => {
    const first = {}; const second = {};
    let evictions = 0;
    await reservePluginProcess(first, 1, () => false, async () => {
      if (++evictions > 8) throw new Error("budget spun on a declined eviction");
      notifyPluginProcessIdle(first);
    });
    try {
      await expect(Promise.race([
        reservePluginProcess(second, 1, () => false, async () => undefined),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("budget did not end promptly")), 100)),
      ])).rejects.toThrow("No evictable plugin process remains");
      expect(evictions).toBe(1);
    } finally {
      releasePluginProcess(first);
      releasePluginProcess(second);
    }
  });
});
