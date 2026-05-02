import { describe, expect, test } from "vitest";

import {
  clearAllResponseIds,
  IncrementalTracker,
  registerIncrementalTracker,
} from "./incremental.js";

describe("Grok incremental response tracking", () => {
  test("clears registered previous_response_id state on compact cleanup", () => {
    const tracker = new IncrementalTracker();
    const unregister = registerIncrementalTracker(tracker);

    try {
      tracker.recordRequest(
        {
          model: "grok-4-fast",
          parallelToolCalls: false,
        },
        [{ role: "user", content: "hello" }],
      );
      tracker.recordResponse({
        previousResponseId: "resp_prev",
        itemsAdded: [{ role: "assistant", content: "hi" }],
        recordedAtMs: Date.now(),
      });

      expect(tracker.previousResponseId()).toBe("resp_prev");
      clearAllResponseIds();
      expect(tracker.previousResponseId()).toBeUndefined();
    } finally {
      unregister();
    }
  });
});
