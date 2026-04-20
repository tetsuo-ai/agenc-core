import { describe, expect, test } from "vitest";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { AssistantMessage, TurnState } from "../session/turn-state.js";
import {
  DEFAULT_REACTIVE_COMPACT_DRIVER,
  resetHasAttemptedReactiveCompact,
  runReactiveCompact,
  type ReactiveCompactDriver,
} from "./reactive-compact.js";

function mkSession(eventLog: EventLog): Session {
  let subIdCounter = 0;
  return {
    eventLog,
    nextInternalSubId: () => `sub-${++subIdCounter}`,
  } as unknown as Session;
}

function mkState(): TurnState {
  return {
    messages: [],
    messagesForQuery: [{ role: "user", content: "hi" }],
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

const lastMessage: AssistantMessage = {
  uuid: "a1",
  role: "assistant",
  text: "Prompt is too long",
  toolCalls: [],
};

describe("reactive-compact (I-40 throw guard)", () => {
  test("default driver disabled → kind='disabled'", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    const out = await runReactiveCompact({ session, state, lastMessage });
    expect(out.kind).toBe("disabled");
  });

  test("I-40: thrown error → kind='threw' + warning emitted + circuit breaker ++", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    state.autoCompactTracking = {
      compacted: false,
      turnId: "t",
      turnCounter: 0,
      consecutiveFailures: 0,
    };
    const warnings: string[] = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string };
      if (e.msg.type === "warning" && p.cause === "reactive_compact_threw") {
        warnings.push(p.cause);
      }
    });
    const driver: ReactiveCompactDriver = {
      ...DEFAULT_REACTIVE_COMPACT_DRIVER,
      isReactiveCompactEnabled: () => true,
      async tryReactiveCompact() {
        throw new Error("summarization failed");
      },
    };
    const out = await runReactiveCompact({
      session,
      state,
      lastMessage,
      driver,
    });
    expect(out.kind).toBe("threw");
    expect(warnings).toContain("reactive_compact_threw");
    expect(state.hasAttemptedReactiveCompact).toBe(true);
    expect(state.autoCompactTracking?.consecutiveFailures).toBe(1);
  });

  test("success: mutates messagesForQuery + sets transition", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    const compacted = [{ role: "user" as const, content: "[summary]" }];
    const driver: ReactiveCompactDriver = {
      ...DEFAULT_REACTIVE_COMPACT_DRIVER,
      isReactiveCompactEnabled: () => true,
      async tryReactiveCompact() {
        return { compactedMessages: compacted };
      },
    };
    const out = await runReactiveCompact({
      session,
      state,
      lastMessage,
      driver,
    });
    expect(out.kind).toBe("compacted");
    expect(state.transition?.reason).toBe("reactive_compact_retry");
    expect(state.messagesForQuery).toEqual(compacted);
    expect(state.hasAttemptedReactiveCompact).toBe(true);
  });

  test("resetHasAttemptedReactiveCompact helper", () => {
    const s = mkState();
    s.hasAttemptedReactiveCompact = true;
    resetHasAttemptedReactiveCompact(s);
    expect(s.hasAttemptedReactiveCompact).toBe(false);
  });

  test("already-attempted branch returns noop without calling driver", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState();
    state.hasAttemptedReactiveCompact = true;
    let called = false;
    const driver: ReactiveCompactDriver = {
      ...DEFAULT_REACTIVE_COMPACT_DRIVER,
      isReactiveCompactEnabled: () => true,
      async tryReactiveCompact() {
        called = true;
        return null;
      },
    };
    const out = await runReactiveCompact({
      session,
      state,
      lastMessage,
      driver,
    });
    expect(out.kind).toBe("noop");
    expect(called).toBe(false);
  });
});
