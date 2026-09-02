import { describe, expect, it } from "vitest";

import { highestInternalSubId } from "../../src/conversation/thread-manager.js";
import type { RolloutItem } from "../../src/session/rollout-store.js";

const event = (id: string, turnId?: string): RolloutItem =>
  ({
    type: "event_msg",
    payload: {
      id,
      msg: { type: "turn_started", payload: turnId === undefined ? {} : { turnId } },
    },
  }) as unknown as RolloutItem;

describe("highestInternalSubId", () => {
  it("reads event ids and turn ids of the conversation and ignores others", () => {
    const items: RolloutItem[] = [
      { type: "session_meta", payload: {} } as unknown as RolloutItem,
      event("sub-conv-a-1"),
      event("sub-conv-a-40", "sub-conv-a-39"),
      event("sub-conv-b-900"),
      event("sub-conv-a-7", "sub-conv-a-3352"),
      event("not-an-id"),
    ];
    // Live shape: a resumed session restarted at 0 and its first turn id
    // collided with the original turn 2's admission record.
    expect(highestInternalSubId(items, "conv-a")).toBe(3352);
    expect(highestInternalSubId(items, "conv-b")).toBe(900);
    expect(highestInternalSubId(items, "conv-c")).toBe(-1);
    expect(highestInternalSubId([], "conv-a")).toBe(-1);
  });
});
