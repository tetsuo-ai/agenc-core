import { describe, expect, it } from "vitest";
import { isHiddenGoalContinuation } from "../../src/session/hidden-goal-history.js";
import { createHistoryReplacedEvent } from "../../src/session/transcript-replacement.js";

describe("hidden goal history", () => {
  const feedback = { role: "user" as const, content: '<goal_gate round="1" of="2">\nContinue.\n</goal_gate>' };
  it("recognizes anonymous durable control rows in live and replayed history", () => {
    expect(isHiddenGoalContinuation(feedback)).toBe(true);
    expect(isHiddenGoalContinuation({ role: "assistant", content: feedback.content })).toBe(false);
    expect(isHiddenGoalContinuation({ role: "user", content: "Please explain " + feedback.content })).toBe(false);
  });
  it("keeps literal user submissions selectable by their durable identity", () => {
    expect(isHiddenGoalContinuation({ ...feedback, id: "human-response" })).toBe(false);
    expect(isHiddenGoalContinuation({ ...feedback, runtimeOnly: { userMessageId: "human-event" } })).toBe(false);
    expect(isHiddenGoalContinuation({ ...feedback, runtimeOnly: { responseItemId: "human-response" } })).toBe(false);
  });
  it("omits internal feedback from a hot transcript replacement but keeps literal prompts", () => {
    const event = createHistoryReplacedEvent({ replacementHistory: [
      feedback,
      { ...feedback, runtimeOnly: { userMessageId: "literal-prompt" } },
    ] });
    expect(event.payload.messages).toHaveLength(1);
    expect(event.payload.messages[0]?.message.content).toBe(feedback.content);
  });
});
