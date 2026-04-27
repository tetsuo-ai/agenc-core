import { describe, expect, test } from "vitest";
import { continuationNudge } from "./continuation-nudge.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import type { Session } from "../session/session.js";

function mkCtx(): TurnContext {
  return {
    config: { maxTurns: 10 },
  } as unknown as TurnContext;
}

function mkSession(): Session {
  return {} as Session;
}

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
        text: "Now I'll create the file.",
        toolCalls: [],
      },
    ],
    toolUseBlocks: [],
    needsFollowUp: false,
    toolResults: [],
    hasAttemptedReactiveCompact: true,
    maxOutputTokensOverride: 64_000,
    maxOutputTokensRecoveryCount: 2,
    recoveryReentryCount: 0,
    continuationNudgeCount: 0,
    streamingToolExecutor: null,
    pendingToolUseSummary: Promise.resolve(null),
    pendingBudgetDecision: undefined,
    lastResponseUsage: undefined,
    turnCount: 1,
    transition: undefined,
    stopHookActive: true,
    stopHookBlockingCount: 0,
  };
}

describe("continuationNudge", () => {
  test("resets recovery-shared state before re-entering prepare-context", async () => {
    const state = mkState();

    await continuationNudge(state, mkCtx(), mkSession());

    expect(state.transition?.reason).toBe("continuation_nudge");
    expect(state.continuationNudgeCount).toBe(1);
    expect(state.maxOutputTokensRecoveryCount).toBe(0);
    expect(state.hasAttemptedReactiveCompact).toBe(false);
    expect(state.maxOutputTokensOverride).toBeUndefined();
    expect(state.pendingToolUseSummary).toBeUndefined();
    expect(state.stopHookActive).toBeUndefined();
    expect(state.messages.at(-1)).toEqual({
      role: "user",
      content: "Continue with the task. Use the appropriate tools to proceed.",
    });
  });

  test("nudges when the model promises execution without emitting tool calls", async () => {
    const state = mkState();
    state.assistantMessages = [
      {
        uuid: "a2",
        role: "assistant",
        text: [
          "Build clean. Continuing M5 parameter array dispatch without stopping.",
          "Executing shopt in src/builtins/shell.c.",
          "Source/eval/shopt/tests incoming sequential tool calls.",
        ].join("\n"),
        toolCalls: [],
      },
    ];

    await continuationNudge(state, mkCtx(), mkSession());

    expect(state.transition?.reason).toBe("continuation_nudge");
    expect(state.continuationNudgeCount).toBe(1);
  });
});
