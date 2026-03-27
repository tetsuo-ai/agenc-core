import { describe, expect, it } from "vitest";
import {
  buildLlmCallUsageLogPayload,
  resolveLlmUsageLoggingConfig,
  shouldEmitLlmUsageLog,
} from "./usage-logging.js";

const baseRecord = {
  callIndex: 2,
  phase: "tool_followup",
  provider: "grok",
  model: "grok-4-fast",
  finishReason: "stop",
  usage: {
    promptTokens: 2410,
    completionTokens: 311,
    totalTokens: 2721,
  },
  durationMs: 1842,
  beforeBudget: {
    messageCount: 8,
    systemMessages: 2,
    userMessages: 2,
    assistantMessages: 2,
    toolMessages: 2,
    estimatedChars: 9_500,
    systemPromptChars: 2_000,
  },
  afterBudget: {
    messageCount: 8,
    systemMessages: 2,
    userMessages: 2,
    assistantMessages: 2,
    toolMessages: 2,
    estimatedChars: 8_900,
    systemPromptChars: 2_000,
  },
  budgetDiagnostics: {
    constrained: true,
    totalBeforeChars: 10_000,
    totalAfterChars: 9_000,
    droppedSections: ["history"],
    sections: {
      history: {
        droppedMessages: 3,
        truncatedMessages: 1,
      },
      tools: {
        droppedMessages: 0,
        truncatedMessages: 0,
      },
    },
  },
};

describe("resolveLlmUsageLoggingConfig", () => {
  it("returns disabled defaults when config is missing", () => {
    expect(resolveLlmUsageLoggingConfig()).toEqual({
      enabled: false,
      level: "info",
      includeIdentifiers: true,
      includeCallContext: true,
      includePromptShape: false,
      includeBudgetDiagnostics: false,
      sampleRate: 1,
    });
  });

  it("applies configured values and clamps sampleRate", () => {
    expect(
      resolveLlmUsageLoggingConfig({
        enabled: true,
        level: "debug",
        includeIdentifiers: false,
        includeCallContext: false,
        includePromptShape: true,
        includeBudgetDiagnostics: true,
        sampleRate: 9,
      }),
    ).toEqual({
      enabled: true,
      level: "debug",
      includeIdentifiers: false,
      includeCallContext: false,
      includePromptShape: true,
      includeBudgetDiagnostics: true,
      sampleRate: 1,
    });
  });
});

describe("shouldEmitLlmUsageLog", () => {
  it("uses deterministic sampling for the same key", () => {
    const config = resolveLlmUsageLoggingConfig({
      enabled: true,
      sampleRate: 0.5,
    });

    expect(shouldEmitLlmUsageLog(config, "trace-1")).toBe(
      shouldEmitLlmUsageLog(config, "trace-1"),
    );
  });

  it("short-circuits for disabled and zero-sample configs", () => {
    expect(
      shouldEmitLlmUsageLog(resolveLlmUsageLoggingConfig(), "trace-1"),
    ).toBe(false);
    expect(
      shouldEmitLlmUsageLog(
        resolveLlmUsageLoggingConfig({ enabled: true, sampleRate: 0 }),
        "trace-1",
      ),
    ).toBe(false);
  });
});

describe("buildLlmCallUsageLogPayload", () => {
  it("includes only bounded metadata selected by config", () => {
    const payload = buildLlmCallUsageLogPayload({
      sessionId: "session-1",
      identifiers: {
        traceId: "trace-1",
        runId: "run-1",
        taskId: "task-1",
        parentSessionId: "parent-1",
      },
      record: baseRecord,
      usedFallback: false,
      rerouted: true,
      downgraded: false,
      config: resolveLlmUsageLoggingConfig({
        enabled: true,
        includeIdentifiers: true,
        includeCallContext: true,
        includePromptShape: true,
        includeBudgetDiagnostics: true,
      }),
    });

    expect(payload).toMatchObject({
      event: "llm.call_usage",
      sessionId: "session-1",
      traceId: "trace-1",
      runId: "run-1",
      taskId: "task-1",
      parentSessionId: "parent-1",
      callIndex: 2,
      phase: "tool_followup",
      provider: "grok",
      model: "grok-4-fast",
      promptTokens: 2410,
      completionTokens: 311,
      totalTokens: 2721,
      durationMs: 1842,
      finishReason: "stop",
      usedFallback: false,
      rerouted: true,
      downgraded: false,
    });
    expect(payload).toHaveProperty("promptShape");
    expect(payload).toHaveProperty("budgetDiagnostics");
  });

  it("suppresses optional fields when disabled and reports missing usage", () => {
    const payload = buildLlmCallUsageLogPayload({
      sessionId: "session-2",
      identifiers: {
        traceId: "trace-2",
      },
      record: {
        ...baseRecord,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
      },
      usedFallback: true,
      rerouted: true,
      downgraded: true,
      config: resolveLlmUsageLoggingConfig({
        enabled: true,
        includeIdentifiers: false,
        includeCallContext: false,
        includePromptShape: false,
        includeBudgetDiagnostics: false,
      }),
    });

    expect(payload).toMatchObject({
      event: "llm.call_usage",
      provider: "grok",
      usageAvailable: false,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    expect(payload).not.toHaveProperty("sessionId");
    expect(payload).not.toHaveProperty("traceId");
    expect(payload).not.toHaveProperty("callIndex");
    expect(payload).not.toHaveProperty("promptShape");
    expect(payload).not.toHaveProperty("budgetDiagnostics");
  });
});
