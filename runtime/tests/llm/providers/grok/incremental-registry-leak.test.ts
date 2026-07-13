import { describe, expect, it } from "vitest";

import {
  IncrementalTracker,
  clearAllResponseIds,
  registerIncrementalTracker,
  registeredIncrementalTrackerCountForTest,
} from "../../../../src/llm/providers/grok/incremental.js";

// M-LLM-3 (core-todo.md): GrokProvider registered its IncrementalTracker in a
// module-global Set removed only by dispose(), which no production path calls (the
// auto-mode classifier / delegate build a fresh grok provider per call). The Set
// held STRONG references, so trackers accumulated unbounded. Fixed by making the
// registry WeakRef-backed so a dropped tracker is collectable.

describe("grok incremental tracker registry — M-LLM-3 leak", () => {
  it("clearAllResponseIds runs over live trackers and unregister removes them", () => {
    const tracker = new IncrementalTracker();
    const unregister = registerIncrementalTracker(tracker);
    expect(registeredIncrementalTrackerCountForTest()).toBeGreaterThanOrEqual(1);
    // clearAllResponseIds must still traverse and clear live trackers (behavior
    // preserved) without throwing.
    expect(() => clearAllResponseIds()).not.toThrow();
    unregister();
    expect(registeredIncrementalTrackerCountForTest()).toBe(0);
  });

  it("does not strongly retain trackers whose owner was dropped", async () => {
    // Register many trackers via a throwaway closure so no strong reference to
    // them survives this block (mirrors per-call providers that never dispose()).
    const created = 50;
    (() => {
      for (let i = 0; i < created; i += 1) {
        registerIncrementalTracker(new IncrementalTracker());
      }
    })();

    // Force GC if the runtime exposes it, then let finalizers run.
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== "function") {
      // Without --expose-gc we cannot force collection; assert the weaker
      // invariant that the count never exceeds what was created (i.e. no runaway),
      // and skip the strict collection assertion.
      expect(registeredIncrementalTrackerCountForTest()).toBeLessThanOrEqual(created);
      return;
    }
    for (let i = 0; i < 5; i += 1) {
      gc();
      await new Promise((r) => setTimeout(r, 0));
    }
    // A strong Set would still report all `created` trackers; the WeakRef set
    // reports them collected (0 live, since nothing else references them).
    expect(registeredIncrementalTrackerCountForTest()).toBe(0);
  });
});
