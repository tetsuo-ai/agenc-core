import { describe, expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../../budget/admitted-model-call.js";
import { createAllowAdmissionHarness } from "../../../budget/admission-test-harness.js";
import { BudgetTracker } from "../../../conversation/token-budget.js";
import type { LLMProvider, LLMResponse } from "../../../llm/types.js";
import {
  computeUsdCost,
  computeUsdCostWithResolution,
  CostSidecar,
  DEFAULT_MODEL_COSTS,
} from "../../../session/cost.js";
import type { Session } from "../../../session/session.js";
import { requestUsageFromGemini } from "./usage.js";

const ACCEPTANCE_USAGE = {
  promptTokenCount: 4,
  candidatesTokenCount: 2,
  thoughtsTokenCount: 1,
  totalTokenCount: 7,
} as const;

describe("requestUsageFromGemini", () => {
  test("maps prompt 4, candidate 2, thinking 1 to completion 3, reasoning 1, total 7", () => {
    expect(requestUsageFromGemini(ACCEPTANCE_USAGE)).toEqual({
      promptTokens: 4,
      completionTokens: 3,
      totalTokens: 7,
      reasoningOutputTokens: 1,
      availability: "reported",
      provenance: "provider",
    });
  });

  test("keeps reasoning as a subset of inclusive completion", () => {
    const usage = requestUsageFromGemini({
      promptTokenCount: 4,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 100,
      totalTokenCount: 106,
    });

    expect(usage.completionTokens).toBe(102);
    expect(usage.reasoningOutputTokens).toBe(100);
    expect(usage.completionTokens).toBeGreaterThan(
      usage.reasoningOutputTokens ?? 0,
    );
    expect(usage.totalTokens).toBe(106);
  });

  test("treats missing optional fields as zero without NaN or invented reasoning", () => {
    const usage = requestUsageFromGemini({
      promptTokenCount: 4,
      candidatesTokenCount: 2,
      totalTokenCount: 6,
    });

    expect(usage).toEqual({
      promptTokens: 4,
      completionTokens: 2,
      totalTokens: 6,
      availability: "reported",
      provenance: "provider",
    });
    expect(Number.isFinite(usage.completionTokens)).toBe(true);
    expect(usage.reasoningOutputTokens).toBeUndefined();
  });

  test("does not treat absent usage metadata as a reported zero-token call", () => {
    expect(requestUsageFromGemini(undefined)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      availability: "unknown",
      provenance: "synthetic",
    });
  });

  test("ignores non-finite token fields instead of producing NaN", () => {
    const usage = requestUsageFromGemini({
      promptTokenCount: Number.NaN,
      candidatesTokenCount: Number.POSITIVE_INFINITY,
      thoughtsTokenCount: "1",
      totalTokenCount: 7,
    });

    expect(usage.promptTokens).toBe(0);
    expect(usage.completionTokens).toBe(0);
    expect(Number.isFinite(usage.completionTokens)).toBe(true);
    expect(usage.reasoningOutputTokens).toBeUndefined();
    expect(usage.totalTokens).toBe(7);
  });

  test("clamps negative provider counts so sums cannot go negative", () => {
    const usage = requestUsageFromGemini({
      promptTokenCount: -4,
      candidatesTokenCount: -2,
      thoughtsTokenCount: -1,
      totalTokenCount: 7,
    });

    expect(usage.promptTokens).toBe(0);
    expect(usage.completionTokens).toBe(0);
    expect(usage.reasoningOutputTokens).toBe(0);
    expect(usage.totalTokens).toBe(7);
  });

  test("documents tool-use prompt tokens as a prompt-side total contribution", () => {
    const diagnostics: Array<{ cause: string; message: string }> = [];
    const usage = requestUsageFromGemini(
      {
        promptTokenCount: 4,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 1,
        toolUsePromptTokenCount: 3,
        totalTokenCount: 10,
      },
      (diagnostic) => diagnostics.push(diagnostic),
    );

    expect(usage).toEqual({
      promptTokens: 4,
      completionTokens: 3,
      totalTokens: 10,
      reasoningOutputTokens: 1,
      availability: "reported",
      provenance: "provider",
    });
    expect(diagnostics).toEqual([]);
  });

  test("does not add tool-use prompt tokens into completion or prompt counts", () => {
    const usage = requestUsageFromGemini({
      promptTokenCount: 7,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 1,
      toolUsePromptTokenCount: 3,
      totalTokenCount: 10,
    });

    expect(usage.promptTokens).toBe(7);
    expect(usage.completionTokens).toBe(3);
    expect(usage.totalTokens).toBe(10);
  });

  test("preserves an inconsistent provider total and emits a diagnostic", () => {
    const diagnostics: Array<{ cause: string; message: string }> = [];
    const usage = requestUsageFromGemini(
      {
        promptTokenCount: 4,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 1,
        totalTokenCount: 99,
      },
      (diagnostic) => diagnostics.push(diagnostic),
    );

    expect(usage.completionTokens).toBe(3);
    expect(usage.reasoningOutputTokens).toBe(1);
    expect(usage.totalTokens).toBe(99);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.cause).toBe("gemini_usage_total_mismatch");
    expect(JSON.parse(diagnostics[0]?.message ?? "{}")).toEqual({
      promptTokenCount: 4,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 1,
      reportedTotalTokenCount: 99,
      reconstructedTotalTokenCount: 7,
      reconstructedTotalTokenCountWithToolUsePrompt: 7,
      inclusiveCompletionTokens: 3,
    });
  });

  test("does not emit a diagnostic when only the authoritative total is present", () => {
    const diagnostics: Array<{ cause: string; message: string }> = [];
    const usage = requestUsageFromGemini(
      { totalTokenCount: 7 },
      (diagnostic) => diagnostics.push(diagnostic),
    );

    expect(usage.totalTokens).toBe(7);
    expect(diagnostics).toEqual([]);
  });
});

describe("Gemini thinking usage consumers", () => {
  test("cost, admission, turn-boundary, and session usage consume inclusive output 3", async () => {
    const usage = requestUsageFromGemini(ACCEPTANCE_USAGE);
    const { admission, reconcile } = createAllowAdmissionHarness();
    const session = {
      conversationId: "session-1",
      services: {
        executionAdmission: admission,
        admissionRequired: true,
        agentControl: { shutdownAgentTree: vi.fn() },
      },
      abortTerminal: vi.fn(),
    } as unknown as Session;
    const provider = {
      name: "gemini",
      getExecutionProfile: async () => ({
        usageReporting: "authoritative" as const,
        supportsMaxOutputTokens: true,
      }),
    } as unknown as LLMProvider;
    const response: LLMResponse = {
      content: "ok",
      toolCalls: [],
      usage,
      model: "gemini-2.5-pro",
      finishReason: "stop",
    };
    await runAdmittedModelCall({
      session,
      provider,
      messages: [{ role: "user", content: "hello" }],
      options: { maxOutputTokens: 64 },
      stepId: "model:gemini:1",
      model: "gemini-2.5-pro",
      providerName: "gemini",
      invoke: async () => response,
    });
    expect(reconcile).toHaveBeenCalledWith(
      "reservation-1",
      expect.objectContaining({ outputTokens: 3 }),
    );
    const settled = reconcile.mock.calls[0]?.[1] as { outputTokens: number };
    const admitted = {
      model: "gemini-2.5-pro",
      provider: "gemini",
      inputTokens: usage.promptTokens,
      outputTokens: settled.outputTokens,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
      webSearchRequests: 0,
      totalTokens: usage.totalTokens,
      turns: 1,
    };
    const exclusiveOutput = {
      ...admitted,
      outputTokens: 2,
    };

    expect(admitted.reasoningOutputTokens).toBe(1);

    const inclusiveCost = computeUsdCost(admitted, DEFAULT_MODEL_COSTS);
    const exclusiveCost = computeUsdCost(exclusiveOutput, DEFAULT_MODEL_COSTS);
    expect(computeUsdCostWithResolution(admitted, DEFAULT_MODEL_COSTS).known).toBe(
      true,
    );
    expect(inclusiveCost).toBeCloseTo(0.000035, 8);
    expect(inclusiveCost).toBeGreaterThan(exclusiveCost);

    const boundary = new BudgetTracker();
    expect(boundary.resolveBoundaryTokens(usage.completionTokens)).toBe(3);

    const sidecar = new CostSidecar({
      defaultProvider: "gemini",
      defaultModel: "gemini-2.5-pro",
    });
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: {
        type: "token_count",
        payload: {
          provider: "gemini",
          model: "gemini-2.5-pro",
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          reasoningOutputTokens: usage.reasoningOutputTokens,
        },
      },
    });
    expect(sidecar.getTotalOutputTokens()).toBe(3);
    expect(sidecar.getPerModelUsage()[0]?.reasoningOutputTokens).toBe(1);
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(inclusiveCost, 8);
  });
});
