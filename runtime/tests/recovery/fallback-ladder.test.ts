import { describe, expect, test } from "vitest";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";
import {
  getRecoveryLock,
  MAX_RECOVERY_REENTRIES,
  RecoveryLadder,
  resetRecoveryReentries,
} from "./fallback-ladder.js";
import type { TriggerActions, TriggerOutcome } from "./triggers.js";

function mkSession(log: EventLog): Session {
  let i = 0;
  return {
    eventLog: log,
    nextInternalSubId: () => `s-${++i}`,
  } as unknown as Session;
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

function alwaysApplyActions(): TriggerActions {
  return {
    async on413(): Promise<TriggerOutcome> {
      return { kind: "applied", reason: "413-applied" };
    },
    async onMedia(): Promise<TriggerOutcome> {
      return { kind: "pass" };
    },
    async onMaxOutputTokens(): Promise<TriggerOutcome> {
      return { kind: "pass" };
    },
    async onStopHookBlocking(): Promise<TriggerOutcome> {
      return { kind: "pass" };
    },
    async onStreamingFallback(): Promise<TriggerOutcome> {
      return { kind: "pass" };
    },
    async onFallbackError(): Promise<TriggerOutcome> {
      return { kind: "pass" };
    },
  };
}

describe("RecoveryLadder", () => {
  test("I-42: hitting MAX_RECOVERY_REENTRIES returns reentry_cap_exhausted", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    state.recoveryReentryCount = MAX_RECOVERY_REENTRIES;
    const ladder = new RecoveryLadder({
      session,
      actions: alwaysApplyActions(),
    });
    const errors: string[] = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string };
      if (e.msg.type === "error" && p.cause === "recovery_loop") {
        errors.push(p.cause);
      }
    });
    const out = await ladder.run(state, undefined, undefined);
    expect(out.kind).toBe("reentry_cap_exhausted");
    expect(errors).toContain("recovery_loop");
  });

  test("I-62: recovery lock is per-session (same session → same lock)", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const lock1 = getRecoveryLock(session);
    const lock2 = getRecoveryLock(session);
    expect(lock1).toBe(lock2);
  });

  test("I-62: concurrent runs serialize", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const order: string[] = [];
    const actions: TriggerActions = {
      ...alwaysApplyActions(),
      async on413() {
        order.push("start:413");
        await new Promise<void>((r) => setTimeout(r, 15));
        order.push("end:413");
        return { kind: "applied", reason: "413" };
      },
    };
    const ladder = new RecoveryLadder({ session, actions });
    // Two stale messages both matching isWithheld413.
    const mkMsg = () => ({
      uuid: "a",
      role: "assistant" as const,
      text: "Prompt is too long",
      toolCalls: [],
    });
    await Promise.all([
      ladder.run(mkState(), mkMsg(), undefined),
      ladder.run(mkState(), mkMsg(), undefined),
    ]);
    // 413-1 must complete before 413-2 starts.
    expect(order).toEqual([
      "start:413",
      "end:413",
      "start:413",
      "end:413",
    ]);
  });

  test("resetRecoveryReentries zeroes the counter", () => {
    const s = mkState();
    s.recoveryReentryCount = 5;
    resetRecoveryReentries(s);
    expect(s.recoveryReentryCount).toBe(0);
  });
});
