import { describe, expect, test } from "vitest";
import { toTombstoneUserMessage, tombstoneOrphans } from "./tombstone.js";
import type { TurnState } from "../session/turn-state.js";

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
    assistantMessages: [
      {
        uuid: "a1",
        role: "assistant",
        text: "partial response before fallback",
        toolCalls: [],
      },
    ],
    toolUseBlocks: [],
    needsFollowUp: true,
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

describe("tombstone", () => {
  test("tombstoneOrphans pushes user-role placeholder + clears buffers", () => {
    const state = mkState();
    const tombstones = tombstoneOrphans(state, {
      reason: "streaming_fallback",
    });
    expect(tombstones).toHaveLength(1);
    expect(state.assistantMessages).toHaveLength(0);
    expect(state.toolResults).toHaveLength(0);
    expect(state.toolUseBlocks).toHaveLength(0);
    expect(state.needsFollowUp).toBe(false);
    expect(state.messages).toHaveLength(1);
    const m = state.messages[0]!;
    expect(m.role).toBe("user");
    expect(typeof m.content).toBe("string");
    expect(m.content as string).toContain("streaming_fallback");
  });

  test("toTombstoneUserMessage includes preview when text available", () => {
    const out = toTombstoneUserMessage(
      {
        uuid: "x",
        role: "assistant",
        text: "hello world",
        toolCalls: [],
      },
      "test",
    );
    expect(out.content as string).toContain("preview: hello world");
  });
});
