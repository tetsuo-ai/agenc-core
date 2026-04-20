import { describe, expect, test } from "vitest";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";
import {
  MAX_OUTPUT_TOKENS_ESCALATED,
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
  runMaxOutputTokensRecovery,
} from "./max-output-tokens.js";

interface FakeExecutor {
  discardCount: number;
  lastReason?: string;
  discard(reason?: string): void;
}

function mkExecutor(): FakeExecutor {
  return {
    discardCount: 0,
    discard(reason?: string) {
      this.discardCount += 1;
      this.lastReason = reason;
    },
  };
}

function mkSession(log: EventLog): Session {
  let i = 0;
  return {
    eventLog: log,
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
    lastResponseUsage: undefined,
    turnCount: 1,
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
    ...opts,
  };
}

describe("runMaxOutputTokensRecovery — T8 hardening", () => {
  test("escalate path: discards pending executor + nulls slot", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const state = mkState({ streamingToolExecutor: executor });

    const outcome = runMaxOutputTokensRecovery({ session, state });

    expect(outcome.kind).toBe("escalate");
    expect(state.maxOutputTokensOverride).toBe(MAX_OUTPUT_TOKENS_ESCALATED);
    expect(executor.discardCount).toBe(1);
    expect(executor.lastReason).toBe("max_output_tokens");
    expect(state.streamingToolExecutor).toBeNull();
  });

  test("escalate path: emits executor_discarded warning with cause max_output_tokens", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const state = mkState({ streamingToolExecutor: executor });

    const warnings: Array<{ cause: string; message: string }> = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string; message?: string };
      if (e.msg.type === "warning" && p.cause && p.message !== undefined) {
        warnings.push({ cause: p.cause, message: p.message });
      }
    });

    runMaxOutputTokensRecovery({ session, state });

    const discarded = warnings.find((w) => w.cause === "executor_discarded");
    expect(discarded).toBeDefined();
    expect(discarded?.message).toBe("max_output_tokens");
  });

  test("continuation path: discards pending executor + nulls slot", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const state = mkState({
      streamingToolExecutor: executor,
      maxOutputTokensOverride: MAX_OUTPUT_TOKENS_ESCALATED,
    });

    const outcome = runMaxOutputTokensRecovery({ session, state });

    expect(outcome.kind).toBe("continuation");
    expect(state.maxOutputTokensRecoveryCount).toBe(1);
    expect(executor.discardCount).toBe(1);
    expect(executor.lastReason).toBe("max_output_tokens");
    expect(state.streamingToolExecutor).toBeNull();
  });

  test("no executor → escalate still works + emits warning", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({ streamingToolExecutor: null });

    const warnings: string[] = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string };
      if (e.msg.type === "warning" && p.cause) warnings.push(p.cause);
    });

    const outcome = runMaxOutputTokensRecovery({ session, state });

    expect(outcome.kind).toBe("escalate");
    expect(warnings).toContain("executor_discarded");
    expect(state.streamingToolExecutor).toBeNull();
  });

  test("escalateAllowed=false → jumps directly to continuation + discards executor", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const state = mkState({ streamingToolExecutor: executor });

    const outcome = runMaxOutputTokensRecovery({
      session,
      state,
      escalateAllowed: false,
    });

    expect(outcome.kind).toBe("continuation");
    expect(executor.discardCount).toBe(1);
    expect(state.streamingToolExecutor).toBeNull();
  });

  test("exhausted path: no executor discard (no state mutation to recover)", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const state = mkState({
      streamingToolExecutor: executor,
      maxOutputTokensOverride: MAX_OUTPUT_TOKENS_ESCALATED,
      maxOutputTokensRecoveryCount: MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
    });

    const outcome = runMaxOutputTokensRecovery({ session, state });

    expect(outcome.kind).toBe("exhausted");
    expect(executor.discardCount).toBe(0);
    // state.streamingToolExecutor untouched on exhausted path — caller
    // surfaces the error; no recovery occurred.
    expect(state.streamingToolExecutor).toBe(executor);
  });

  test("executor.discard throwing is absorbed (I-41 re-entrance guard)", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const throwingExecutor = {
      discard(_reason?: string): void {
        throw new Error("re-entrance");
      },
    };
    const state = mkState({ streamingToolExecutor: throwingExecutor });

    expect(() =>
      runMaxOutputTokensRecovery({ session, state }),
    ).not.toThrow();
    expect(state.streamingToolExecutor).toBeNull();
  });
});
