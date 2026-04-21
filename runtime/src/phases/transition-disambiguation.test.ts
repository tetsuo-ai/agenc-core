import { describe, expect, test } from "vitest";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import { FallbackTriggeredError } from "../recovery/api-errors.js";
import { isStreamingFallbackOccured } from "../recovery/api-errors.js";
import { Phase, PhaseTransition } from "./index.js";
import { postSampleRecovery } from "./post-sample-recovery.js";

function mkCtx(): TurnContext {
  return {
    subId: "t1",
    realtimeActive: false,
    config: { model: "stub", cwd: "/tmp", permissions: { allowLoginShell: false } },
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
    pendingProviderSwitch: null,
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

describe("T8 transition-reason disambiguation", () => {
  test("PhaseTransition routes both model_fallback and streaming_fallback_retry to PrepareContext", () => {
    expect(PhaseTransition.model_fallback).toBe(Phase.PrepareContext);
    expect(PhaseTransition.streaming_fallback_retry).toBe(Phase.PrepareContext);
    // Explicitly distinct keys — no silent collapse.
    expect(PhaseTransition.model_fallback).toBe(
      PhaseTransition.streaming_fallback_retry,
    );
  });

  test("onFallbackError path sets transition reason = model_fallback (unchanged)", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        { uuid: "a1", role: "assistant", text: "partial", toolCalls: [] },
      ],
      // Pre-seed the stream error so the ladder's FallbackTriggeredError
      // trigger fires.
      lastStreamError: new FallbackTriggeredError("grok-3-fast", "grok-3"),
    } as Partial<TurnState> & { lastStreamError?: unknown });

    await postSampleRecovery(state, mkCtx(), session);

    expect(state.transition?.reason).toBe("model_fallback");
  });

  test("onStreamingFallback path sets transition reason = streaming_fallback_retry (distinct)", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a1",
          role: "assistant",
          text: "partial provider output",
          toolCalls: [],
          apiError: "provider_error",
        },
      ],
      lastStreamError: new Error("stream aborted after partial output"),
    });

    await postSampleRecovery(state, mkCtx(), session);

    expect(state.transition?.reason).toBe("streaming_fallback_retry");
  });

  test("isStreamingFallbackOccured matches partial provider-error retries, not model_fallback", () => {
    const s1 = mkState({
      assistantMessages: [
        {
          uuid: "a1",
          role: "assistant",
          text: "partial provider output",
          toolCalls: [],
          apiError: "provider_error",
        },
      ],
      lastStreamError: new Error("stream aborted after partial output"),
    } as Partial<TurnState> & { lastStreamError?: unknown });
    const s2 = mkState({
      transition: { reason: "model_fallback" },
      lastStreamError: new FallbackTriggeredError("grok-3-fast", "grok-3"),
    } as Partial<TurnState> & { lastStreamError?: unknown });
    expect(isStreamingFallbackOccured(s1)).toBe(true);
    expect(isStreamingFallbackOccured(s2)).toBe(false);
  });

  test("onStreamingFallback emits executor_discarded warning with cause streaming_fallback", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const warnings: Array<{ cause: string; message: string }> = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string; message?: string };
      if (e.msg.type === "warning" && p.cause && p.message !== undefined) {
        warnings.push({ cause: p.cause, message: p.message });
      }
    });
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a1",
          role: "assistant",
          text: "partial provider output",
          toolCalls: [],
          apiError: "provider_error",
        },
      ],
      lastStreamError: new Error("stream aborted after partial output"),
    });

    await postSampleRecovery(state, mkCtx(), session);

    const discarded = warnings.find((w) => w.cause === "executor_discarded");
    expect(discarded).toBeDefined();
    expect(discarded?.message).toBe("streaming_fallback");
  });
});
