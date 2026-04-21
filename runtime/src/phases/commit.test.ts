import { describe, expect, test, vi } from "vitest";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import { commit } from "./commit.js";

function mkState(opts: Partial<TurnState> = {}): TurnState {
  return {
    messages: [{ role: "user", content: "start" }],
    messagesForQuery: [],
    autoCompactTracking: undefined,
    taskBudgetRemaining: undefined,
    snipTokensFreed: 0,
    pendingMemoryPrefetch: undefined,
    pendingSkillPrefetch: undefined,
    contentReplacementState: undefined,
    assistantMessages: [],
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
    lastResponseUsage: undefined,
    turnCount: 0,
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
    ...opts,
  };
}

function mkSession(): Session {
  return {
    emit: vi.fn(),
    nextInternalSubId: () => "sub-1",
    rolloutStore: undefined,
  } as unknown as Session;
}

describe("commit", () => {
  test("keeps resolved tool-use summaries out of model-visible history", async () => {
    const upstreamSummary = {
      type: "tool_use_summary",
      summary: "Searched the repo and found the bootstrap entry point.",
      precedingToolUseIds: ["tool-1"],
      uuid: "sum-1",
      timestamp: "2026-04-21T00:00:00.000Z",
    };
    const legacySummary = {
      type: "tool_use_summary",
      content: "Ran tests and confirmed the fix.",
      uuid: "sum-2",
    };

    for (const pending of [upstreamSummary, legacySummary]) {
      const state = mkState({
        pendingToolUseSummary: Promise.resolve(pending as never),
      });

      await commit(state, {} as TurnContext, mkSession());

      expect(state.pendingToolUseSummary).toBeUndefined();
      expect(state.turnCount).toBe(1);
      expect(state.messages).toEqual([{ role: "user", content: "start" }]);
    }
  });

  test("emits the resolved summary text back through agent_message", async () => {
    const session = mkSession();
    const state = mkState({
      pendingToolUseSummary: Promise.resolve({
        type: "tool_use_summary",
        summary: "Indexed the repo and queued the follow-up work.",
        uuid: "sum-3",
      } as never),
    });

    await commit(state, {} as TurnContext, session);

    expect(session.emit).toHaveBeenCalledWith({
      id: "sub-1",
      msg: {
        type: "agent_message",
        payload: {
          message: "Indexed the repo and queued the follow-up work.",
        },
      },
    });
  });

  test("summary promise rejection is non-fatal and still clears the pending slot", async () => {
    const state = mkState({
      pendingToolUseSummary: Promise.reject(new Error("summary_boom")),
    });

    await commit(state, {} as TurnContext, mkSession());

    expect(state.pendingToolUseSummary).toBeUndefined();
    expect(state.turnCount).toBe(1);
    expect(state.messages).toEqual([{ role: "user", content: "start" }]);
  });
});
