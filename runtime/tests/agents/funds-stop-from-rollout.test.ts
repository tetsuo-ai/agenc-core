import { describe, expect, it } from "vitest";
import { fundsStopFromRolloutItems } from "../../src/agents/cross-provider.js";

describe("fundsStopFromRolloutItems", () => {
  it("is true only for a journalled subagent funds notice", () => {
    expect(fundsStopFromRolloutItems([
      { type: "response_item", payload: { role: "assistant", content: "working" } },
      { type: "event_msg", payload: { msg: { type: "subagent_funds_notice" } } },
    ])).toBe(true);
  });

  it("ignores other events, empty journals, and malformed items", () => {
    expect(fundsStopFromRolloutItems([])).toBe(false);
    expect(fundsStopFromRolloutItems([
      { type: "event_msg", payload: { msg: { type: "turn_aborted" } } },
      { type: "event_msg", payload: { msg: { type: "subagent_turn_outcome" } } },
      null,
      { type: "event_msg" },
      { payload: { msg: { type: "subagent_funds_notice" } } },
    ])).toBe(false);
  });

  it("finds a funds notice that is not the last item", () => {
    expect(fundsStopFromRolloutItems([
      { type: "event_msg", payload: { msg: { type: "subagent_funds_notice" } } },
      { type: "event_msg", payload: { msg: { type: "user_message" } } },
    ])).toBe(true);
  });
});
