import { describe, expect, it } from "vitest";
import { withoutSyntheticProcessKilledAborts } from "../../src/conversation/thread-manager.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";

function event(type: string, reason?: string): RolloutItem {
  return {
    type: "event_msg",
    payload: {
      id: type,
      msg: reason === undefined ? { type } : { type, payload: { reason } },
    },
  } as RolloutItem;
}

describe("withoutSyntheticProcessKilledAborts", () => {
  it("drops only bootstrap process_killed abort markers", () => {
    const kept = event("turn_aborted", "interrupted");
    const notice = event("subagent_funds_notice");
    const response = { type: "response_item", payload: { role: "user", content: "continue" } } as RolloutItem;
    const killed = event("turn_aborted", "process_killed");
    expect(withoutSyntheticProcessKilledAborts([killed, kept, notice, response, killed]))
      .toEqual([kept, notice, response]);
  });

  it("leaves an empty journal and a journal without crash markers unchanged", () => {
    const items = [
      event("turn_complete"),
      { type: "response_item", payload: { role: "assistant", content: "done" } } as RolloutItem,
    ];
    expect(withoutSyntheticProcessKilledAborts([])).toEqual([]);
    expect(withoutSyntheticProcessKilledAborts(items)).toEqual(items);
  });
});
