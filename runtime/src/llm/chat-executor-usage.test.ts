import { describe, expect, it } from "vitest";

import {
  accumulateUsage,
  createCallUsageRecord,
} from "./chat-executor-usage.js";
import type { ChatPromptShape } from "./chat-executor-types.js";
import type { LLMResponse, LLMUsage } from "./types.js";

// ============================================================================
// Test helpers
// ============================================================================

function makeUsage(
  promptTokens: number,
  completionTokens: number,
  totalTokens: number = promptTokens + completionTokens,
): LLMUsage {
  return { promptTokens, completionTokens, totalTokens };
}

function makeShape(overrides: Partial<ChatPromptShape> = {}): ChatPromptShape {
  return {
    messageCount: 0,
    systemMessages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolMessages: 0,
    estimatedChars: 0,
    systemPromptChars: 0,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: "hello",
    toolCalls: [],
    usage: makeUsage(10, 5),
    model: "mock-model",
    finishReason: "stop",
    ...overrides,
  };
}

// ============================================================================
// accumulateUsage
// ============================================================================

describe("accumulateUsage", () => {
  it("mutates the running cumulative in place", () => {
    const cumulative: LLMUsage = makeUsage(10, 5);
    const delta: LLMUsage = makeUsage(3, 7);

    accumulateUsage(cumulative, delta);

    expect(cumulative).toEqual({
      promptTokens: 13,
      completionTokens: 12,
      totalTokens: 25,
    });
  });

  it("handles zero-value deltas without changing the cumulative", () => {
    const cumulative: LLMUsage = makeUsage(100, 200, 300);

    accumulateUsage(cumulative, makeUsage(0, 0, 0));

    expect(cumulative).toEqual({
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
    });
  });

  it("composes multiple deltas into a correct running total", () => {
    const cumulative: LLMUsage = makeUsage(0, 0, 0);

    accumulateUsage(cumulative, makeUsage(1, 2));
    accumulateUsage(cumulative, makeUsage(4, 8));
    accumulateUsage(cumulative, makeUsage(7, 14));

    expect(cumulative).toEqual({
      promptTokens: 12,
      completionTokens: 24,
      totalTokens: 36,
    });
  });
});

// ============================================================================
// createCallUsageRecord
// ============================================================================

describe("createCallUsageRecord", () => {
  it("assembles the canonical record shape from inputs", () => {
    const before = makeShape({ messageCount: 3, estimatedChars: 100 });
    const after = makeShape({ messageCount: 5, estimatedChars: 180 });
    const response = makeResponse({
      model: "m-xl",
      finishReason: "tool_calls",
      usage: makeUsage(42, 8, 50),
    });

    const record = createCallUsageRecord({
      callIndex: 3,
      phase: "tool_followup",
      providerName: "primary",
      response,
      beforeBudget: before,
      afterBudget: after,
      durationMs: 128,
    });

    expect(record).toEqual({
      callIndex: 3,
      phase: "tool_followup",
      provider: "primary",
      model: "m-xl",
      finishReason: "tool_calls",
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
      durationMs: 128,
      beforeBudget: before,
      afterBudget: after,
      providerRequestMetrics: undefined,
      budgetDiagnostics: undefined,
      statefulDiagnostics: undefined,
      compactionDiagnostics: undefined,
    });
  });

  it("surfaces providerRequestMetrics, statefulDiagnostics, and compactionDiagnostics from the response", () => {
    const response = makeResponse({
      requestMetrics: { toolSchemaChars: 2048 },
      stateful: {
        enabled: true,
        attempted: true,
        continued: true,
        store: true,
        fallbackToStateless: false,
        events: [],
      },
      compaction: {
        triggered: true,
        strategy: "provider_native",
        eventCount: 1,
      },
    });

    const record = createCallUsageRecord({
      callIndex: 1,
      phase: "initial",
      providerName: "primary",
      response,
      beforeBudget: makeShape(),
      afterBudget: makeShape(),
      durationMs: 42,
    });

    expect(record.providerRequestMetrics).toEqual({ toolSchemaChars: 2048 });
    expect(record.statefulDiagnostics).toEqual({
      enabled: true,
      attempted: true,
      continued: true,
      store: true,
      fallbackToStateless: false,
      events: [],
    });
    expect(record.compactionDiagnostics).toEqual({
      triggered: true,
      strategy: "provider_native",
      eventCount: 1,
    });
  });

  it("passes budgetDiagnostics through when provided", () => {
    const record = createCallUsageRecord({
      callIndex: 1,
      phase: "initial",
      providerName: "primary",
      response: makeResponse(),
      beforeBudget: makeShape(),
      afterBudget: makeShape(),
      durationMs: 10,
      budgetDiagnostics: {
        constrained: true,
        totalEstimatedChars: 1234,
        totalHardCapChars: 8000,
        sections: {},
      } as never,
    });

    expect(record.budgetDiagnostics).toBeDefined();
    expect(record.budgetDiagnostics?.constrained).toBe(true);
  });

  it("records the compaction phase when the call is a pre-execution summarization", () => {
    const record = createCallUsageRecord({
      callIndex: 0,
      phase: "compaction",
      providerName: "primary",
      response: makeResponse({ finishReason: "stop" }),
      beforeBudget: makeShape(),
      afterBudget: makeShape(),
      durationMs: 6,
    });

    expect(record.callIndex).toBe(0);
    expect(record.phase).toBe("compaction");
  });
});
