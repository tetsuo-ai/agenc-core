import { describe, it, expect } from "vitest";
import {
  computeUsdCostWithResolution,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "src/session/cost.js";

// gaphunt3 #12: Grok reasoning tokens are reported as a SUBSET of output
// tokens (OpenAI/xAI Responses convention). Cost computation must not charge
// the full output rate AND the reasoning rate on the same tokens — it should
// bill the full output rate only on (outputTokens − reasoningOutputTokens)
// and the reasoning portion at reasoningOutputUsdPer1K.

function usage(overrides: Partial<ModelUsage>): ModelUsage {
  return {
    model: "grok-4.20-0309-reasoning",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    totalTokens: 0,
    turns: 0,
    ...overrides,
  };
}

describe("gaphunt3 #12 — reasoning tokens are not double-charged", () => {
  it("bills grok reasoning tokens once (reasoning ⊆ output)", () => {
    // grok-4.20-0309-reasoning: outputUsdPer1K = 0.012, reasoningOutputUsdPer1K = 0.012.
    // 1000 output tokens of which 400 are reasoning:
    //   full-rate output: (1000 - 400)/1000 * 0.012 = 0.0072
    //   reasoning:               400/1000 * 0.012 = 0.0048
    //   total = 0.012 (NOT 0.012 + 0.0048 = 0.0168, the double-charged value).
    const result = computeUsdCostWithResolution(
      usage({ outputTokens: 1000, reasoningOutputTokens: 400 }),
      DEFAULT_MODEL_COSTS,
    );
    expect(result.matchedKey).toBe("grok-4.20-0309-reasoning");
    expect(result.costUsd).toBeCloseTo(0.012, 6);
    // Revert guard: the buggy formula yields 0.0168.
    expect(result.costUsd).not.toBeCloseTo(0.0168, 6);
  });

  it("with no reasoning tokens, output is billed at the full output rate", () => {
    const result = computeUsdCostWithResolution(
      usage({ outputTokens: 1000, reasoningOutputTokens: 0 }),
      DEFAULT_MODEL_COSTS,
    );
    // 1000/1000 * 0.012 = 0.012
    expect(result.costUsd).toBeCloseTo(0.012, 6);
  });

  it("does not subtract reasoning for models without a reasoning rate", () => {
    // grok-4-fast defines no reasoningOutputUsdPer1K, so reasoning tokens are
    // simply part of output and billed only at the output rate (0.01/1K).
    const result = computeUsdCostWithResolution(
      usage({
        model: "grok-4-fast",
        outputTokens: 1000,
        reasoningOutputTokens: 400,
      }),
      DEFAULT_MODEL_COSTS,
    );
    // Output billed on full 1000 tokens (no separate reasoning rate to apply):
    //   1000/1000 * 0.01 = 0.01
    expect(result.matchedKey).toBe("grok-4-fast");
    expect(result.costUsd).toBeCloseTo(0.01, 6);
  });
});
