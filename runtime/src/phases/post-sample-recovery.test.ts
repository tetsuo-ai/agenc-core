import { describe, expect, test } from "vitest";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import { postSampleRecovery } from "./post-sample-recovery.js";

function mkCtx(): TurnContext {
  return {
    subId: "t1",
    realtimeActive: false,
    config: {
      model: "stub",
      cwd: "/tmp",
      permissions: { allowLoginShell: false },
    },
    configSnapshot: {},
    modelInfo: { slug: "stub" },
    cwd: "/tmp",
    depth: 0,
  } as unknown as TurnContext;
}

function mkSession(log: EventLog): Session {
  let i = 0;
  return {
    conversationId: "conv-1",
    eventLog: log,
    services: {
      hooks: {},
      provider: { name: "grok" },
    },
    nextInternalSubId: () => `s-${++i}`,
  } as unknown as Session;
}

function mkState(opts: Partial<TurnState> = {}): TurnState {
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
    ...opts,
  };
}

describe("post-sample-recovery integration", () => {
  test("I-22: pendingBudgetDecision=stop → transition=token_budget_continuation + reset flag", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      pendingBudgetDecision: {
        kind: "stop",
        reason: "token_budget_exceeded by 500 (mid-stream)",
      },
      hasAttemptedReactiveCompact: true,
    });
    const warnings: string[] = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string };
      if (e.msg.type === "warning" && p.cause === "token_budget_continuation") {
        warnings.push(p.cause);
      }
    });
    await postSampleRecovery(state, mkCtx(), session);
    expect(state.transition?.reason).toBe("token_budget_continuation");
    // Critical subtlety: token-budget-continuation path resets the flag.
    expect(state.hasAttemptedReactiveCompact).toBe(false);
    expect(state.pendingBudgetDecision).toBeUndefined();
    expect(warnings).toContain("token_budget_continuation");
    // continuation nudge message injected.
    expect(state.messages[state.messages.length - 1]!.role).toBe("user");
  });

  test("max-output-tokens first attempt: escalate sets override + transition", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "",
          toolCalls: [],
          apiError: "max_output_tokens",
        },
      ],
    });
    await postSampleRecovery(state, mkCtx(), session);
    expect(state.transition?.reason).toBe("max_output_tokens_escalate");
    expect(state.maxOutputTokensOverride).toBe(64_000);
  });

  test("normal stream (no recovery) → no transition", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a",
          role: "assistant",
          text: "happy path",
          toolCalls: [],
        },
      ],
    });
    await postSampleRecovery(state, mkCtx(), session);
    expect(state.transition).toBeUndefined();
  });
});
