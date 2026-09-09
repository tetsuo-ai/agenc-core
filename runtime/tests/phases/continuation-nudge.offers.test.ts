import { describe, expect, test } from "vitest";
import { continuationNudge } from "../../src/phases/continuation-nudge.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { mkCtx, mkSession } from "../fixtures.js";

describe("continuation consent boundary", () => {
  test.each([
    "I'm AgenC, an autonomous coding agent for software engineering in this workspace.\n\nThis directory is essentially empty except for TASK.md: a notes CLI exercise. I can implement notes.mjs (add/list/show/delete, notes.json storage, black-box node:test tests, and a short README) if you want that next.",
    "I can run the tests next if you'd like.",
    "Would you like me to run the tests next?",
    "If you want, I'll create the file.",
    "Let me run the tests if you approve.",
    "Let me know whether I should run the tests next.",
    "Suggested next step: review the source and tests next.",
    "I'll run the tests after you approve.",
    "With your permission, I'll update the file.",
    "I'll wait until you confirm, then I'll create the file.",
    "Once you give me the go-ahead, I'll run the tests.",
    "I'll update the file pending your approval.",
    "I'll run the tests after your confirmation.",
  ])("does not turn an offer or suggestion into execution: %s", async (text) => {
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, { role: "user", content: "Inspect the directory and suggest one useful next step." });
    state.assistantMessages = [{ uuid: "offer", role: "assistant", text, toolCalls: [] }];
    const { session } = mkSession();

    await continuationNudge(state, ctx, session);

    expect(state.transition).toBeUndefined();
    expect(state.continuationNudgeCount).toBe(0);
    expect(state.messages).toHaveLength(1);
  });

  test.each([
    "Now I'll create the file.",
    "I'll run the tests next.",
    "Let me verify the result. Now I'll run the tests.",
    "Source/eval/shopt/tests incoming sequential tool calls.",
  ])("retains an explicit execution continuation: %s", async (text) => {
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, { role: "user", content: "Implement and test the feature." });
    state.assistantMessages = [{ uuid: "execution", role: "assistant", text, toolCalls: [] }];
    const { session } = mkSession();

    await continuationNudge(state, ctx, session);

    expect(state.transition?.reason).toBe("continuation_nudge");
    expect(state.continuationNudgeCount).toBe(1);
  });
});
