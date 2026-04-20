import { describe, expect, test } from "vitest";
import {
  evaluateWithholdCascade,
  isMediaWithholdRoute,
} from "./withhold-cascading.js";
import type { AssistantMessage, TurnState } from "../session/turn-state.js";

function mkState(): TurnState {
  return {
    messages: [],
    messagesForQuery: [],
    autoCompactTracking: undefined,
    taskBudgetRemaining: undefined,
    snipTokensFreed: 0,
    pendingMemoryPrefetch: undefined,
    pendingSkillPrefetch: undefined,
    contentReplacementState: undefined,
    assistantMessages: [],
    toolUseBlocks: [],
    needsFollowUp: false,
    toolResults: [],
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: undefined,
    maxOutputTokensRecoveryCount: 0,
    recoveryReentryCount: 0,
    continuationNudgeCount: 0,
    streamingToolExecutor: null,
    pendingToolUseSummary: undefined,
    pendingBudgetDecision: undefined,
    turnCount: 1,
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
  };
}

const pltMsg: AssistantMessage = {
  uuid: "a1",
  role: "assistant",
  text: "Prompt is too long: 137500 tokens > 135000 maximum",
  toolCalls: [],
};

const mediaMsg: AssistantMessage = {
  uuid: "a2",
  role: "assistant",
  text: "image exceeds 5MB maximum",
  toolCalls: [],
};

describe("withhold-cascading two-gate check", () => {
  test("first-attempt PTL → collapse-drain", () => {
    const s = mkState();
    expect(evaluateWithholdCascade(s, pltMsg).kind).toBe(
      "route_to_collapse_drain",
    );
  });

  test("second-attempt PTL (already drained) → reactive-compact", () => {
    const s = mkState();
    s.transition = { reason: "collapse_drain_retry" };
    expect(evaluateWithholdCascade(s, pltMsg).kind).toBe(
      "route_to_reactive_compact",
    );
  });

  test("non-PTL message → not_withheld", () => {
    const s = mkState();
    const msg: AssistantMessage = {
      ...pltMsg,
      text: "happy path response",
    };
    expect(evaluateWithholdCascade(s, msg).kind).toBe("not_withheld");
  });

  test("isMediaWithholdRoute detects media errors", () => {
    expect(isMediaWithholdRoute(mediaMsg)).toBe(true);
    expect(isMediaWithholdRoute(pltMsg)).toBe(false);
  });
});
