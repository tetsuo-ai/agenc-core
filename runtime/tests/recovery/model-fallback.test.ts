import { describe, expect, test } from "vitest";
import {
  FACTORY_PROVIDER_MARKER,
  FACTORY_PROVIDER_STATE,
} from "../llm/provider.js";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnState, UserMessage } from "../session/turn-state.js";
import { FallbackTriggeredError } from "./api-errors.js";
import { runModelFallback } from "./model-fallback.js";

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
    conversationId: "conv-1",
    eventLog: log,
    services: {
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

describe("runModelFallback — T8 hardening", () => {
  test("discards pending executor + nulls state.streamingToolExecutor", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const state = mkState({
      streamingToolExecutor: executor,
      assistantMessages: [
        { uuid: "a1", role: "assistant", text: "partial", toolCalls: [] },
      ],
    });

    runModelFallback({
      session,
      state,
      error: new FallbackTriggeredError("grok-3-fast", "grok-3"),
    });

    expect(executor.discardCount).toBe(1);
    expect(executor.lastReason).toBe("model_fallback");
    expect(state.streamingToolExecutor).toBeNull();
  });

  test("emits typed executor_discarded warning with cause model_fallback", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const state = mkState({
      streamingToolExecutor: executor,
      assistantMessages: [
        { uuid: "a1", role: "assistant", text: "partial", toolCalls: [] },
      ],
    });

    const warnings: Array<{ cause: string; message: string }> = [];
    log.subscribe((e) => {
      const p = e.msg.payload as { cause?: string; message?: string };
      if (e.msg.type === "warning" && p.cause && p.message !== undefined) {
        warnings.push({ cause: p.cause, message: p.message });
      }
    });

    runModelFallback({
      session,
      state,
      error: new FallbackTriggeredError("grok-3-fast", "grok-3"),
    });

    const discarded = warnings.find((w) => w.cause === "executor_discarded");
    expect(discarded).toBeDefined();
    expect(discarded?.message).toBe("model_fallback");
  });

  test("synthesizes terminal tool_results for orphan tool_use before fallback", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a1",
          role: "assistant",
          text: "partial",
          toolCalls: [
            { id: "tc-1", name: "bash", arguments: "{}" },
            { id: "tc-2", name: "read", arguments: "{}" },
          ],
        },
      ],
      // tc-1 already has a result → only tc-2 is orphan.
      toolResults: [
        {
          uuid: "u1",
          role: "user",
          toolCallId: "tc-1",
          toolName: "bash",
          content: "ok",
        } as UserMessage,
      ],
    });

    const outcome = runModelFallback({
      session,
      state,
      error: new FallbackTriggeredError("grok-3-fast", "grok-3"),
    });

    expect(outcome.orphanToolResultsSynthesized).toBe(1);
    // Synthetic message appended to state.messages before tombstone.
    const toolMsgs = state.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    const syntheticContent = toolMsgs[0]!.content as string;
    expect(syntheticContent).toContain("tc-2");
    expect(syntheticContent).toContain("tool_use_error");
  });

  test("adds assistant tool call before synthetic terminal tool result during fallback", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        {
          uuid: "a1",
          role: "assistant",
          text: "partial",
          toolCalls: [{ id: "tc-1", name: "bash", arguments: "{}" }],
        },
      ],
    });

    runModelFallback({
      session,
      state,
      error: new FallbackTriggeredError("grok-3-fast", "grok-3"),
    });

    const assistantIndex = state.messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls?.some((call) => call.id === "tc-1") === true,
    );
    const toolIndex = state.messages.findIndex(
      (message) => message.role === "tool" && message.toolCallId === "tc-1",
    );

    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(assistantIndex);
  });

  test("sets transition reason model_fallback (reserved for FallbackTriggeredError path)", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        { uuid: "a1", role: "assistant", text: "partial", toolCalls: [] },
      ],
    });

    runModelFallback({
      session,
      state,
      error: new FallbackTriggeredError("grok-3-fast", "grok-3"),
    });

    expect(state.transition?.reason).toBe("model_fallback");
  });

  test("no orphans → orphanToolResultsSynthesized=0, no tool messages appended", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        { uuid: "a1", role: "assistant", text: "done", toolCalls: [] },
      ],
    });

    const outcome = runModelFallback({
      session,
      state,
      error: new FallbackTriggeredError("grok-3-fast", "grok-3"),
    });

    expect(outcome.orphanToolResultsSynthesized).toBe(0);
    expect(state.messages.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  test("falls back to state.streamingToolExecutor when opts.executor omitted", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const executor = mkExecutor();
    const state = mkState({
      streamingToolExecutor: executor,
      assistantMessages: [
        { uuid: "a1", role: "assistant", text: "partial", toolCalls: [] },
      ],
    });

    runModelFallback({
      session,
      state,
      error: new FallbackTriggeredError("grok-3-fast", "grok-3"),
      // no executor opt
    });

    expect(executor.discardCount).toBe(1);
    expect(state.streamingToolExecutor).toBeNull();
  });

  test("stages fallback switches with the compat provider identity, not the generic adapter name", () => {
    const log = new EventLog();
    const session = mkSession(log);
    (session.services.provider as Record<PropertyKey, unknown>).name = "openai";
    (session.services.provider as Record<PropertyKey, unknown>)[
      FACTORY_PROVIDER_MARKER
    ] = true;
    (session.services.provider as Record<PropertyKey, unknown>)[
      FACTORY_PROVIDER_STATE
    ] = {
      provider: "openrouter",
      options: {
        apiKey: "or-test",
        baseURL: "https://openrouter.ai/api/v1",
        model: "openai/gpt-5",
      },
    };
    const state = mkState({
      assistantMessages: [
        { uuid: "a1", role: "assistant", text: "partial", toolCalls: [] },
      ],
    });

    runModelFallback({
      session,
      state,
      error: new FallbackTriggeredError("openai/gpt-5", "openai/gpt-5-mini"),
    });

    expect(session.pendingProviderSwitch).toEqual({
      provider: "openrouter",
      model: "openai/gpt-5-mini",
    });
  });

  test("honors explicit cross-provider fallback target from the retry layer", () => {
    const log = new EventLog();
    const session = mkSession(log);
    const state = mkState({
      assistantMessages: [
        { uuid: "a1", role: "assistant", text: "partial", toolCalls: [] },
      ],
    });

    runModelFallback({
      session,
      state,
      error: new FallbackTriggeredError("grok-4-fast", "gpt-5", {
        fromProvider: "grok",
        toProvider: "openai",
        reason: "provider_fallback_ladder",
      }),
    });

    expect(session.pendingProviderSwitch).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
    expect(state.pendingAdmissionFallback).toEqual({
      fromModel: "grok-4-fast",
      toModel: "gpt-5",
      fromProvider: "grok",
      toProvider: "openai",
      reason: "provider_fallback_ladder",
    });
  });
});
