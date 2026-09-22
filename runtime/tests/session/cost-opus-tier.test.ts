import { describe, expect, it } from "vitest";

import {
  computeUsdCost,
  computeUsdCostWithResolution,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "../../src/session/cost.js";

// M-COST-1 / M-COST-2: canonicalModel collapsed every claude-opus-4*
// onto the $15/$75 tier, but Opus dropped to $5/$25 with 4.5 (see the canonical
// utils/modelCost.ts). That 3x overcharge surfaced in the live CostSidecar
// (session-transcript) and in background-agent dollar_cap enforcement, which both
// price via DEFAULT_MODEL_COSTS. This test pins the corrected tiers.

function usage(model: string): ModelUsage {
  return {
    model,
    inputTokens: 100_000,
    outputTokens: 100_000,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    totalTokens: 200_000,
    turns: 1,
  };
}

// 100k input + 100k output:
//   $5/$25:  100*0.005 + 100*0.025 = 0.5 + 2.5 = 3.0
//   $15/$75: 100*0.015 + 100*0.075 = 1.5 + 7.5 = 9.0
const EXPECTED_5_25 = 3.0;
const EXPECTED_15_75 = 9.0;

describe("session cost — Opus 4.5-4.8 priced at $5/$25 (not $15/$75)", () => {
  it.each([
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-opus-4-8-1m",
    "anthropic/claude-opus-4-8",
  ])("prices modern Opus %s at the 5-over-25 tier", (model) => {
    const result = computeUsdCostWithResolution(usage(model), DEFAULT_MODEL_COSTS);
    expect(result.costUsd).toBeCloseTo(EXPECTED_5_25, 6);
    // Revert guard: the pre-fix registry collapsed these onto $15/$75 = 9.0.
    expect(result.costUsd).not.toBeCloseTo(EXPECTED_15_75, 6);
  });

  it.each(["claude-opus-4-1", "claude-opus-4", "claude-opus-4-0"])(
    "keeps legacy Opus %s at the 15-over-75 tier",
    (model) => {
      const result = computeUsdCostWithResolution(usage(model), DEFAULT_MODEL_COSTS);
      expect(result.costUsd).toBeCloseTo(EXPECTED_15_75, 6);
    },
  );

  it("does not confuse opus-4-1 (legacy) with a future opus-4-10 (modern)", () => {
    const legacy = computeUsdCostWithResolution(usage("claude-opus-4-1"), DEFAULT_MODEL_COSTS);
    const future = computeUsdCostWithResolution(usage("claude-opus-4-10"), DEFAULT_MODEL_COSTS);
    expect(legacy.costUsd).toBeCloseTo(EXPECTED_15_75, 6);
    expect(future.costUsd).toBeCloseTo(EXPECTED_5_25, 6);
  });

  // Claude Opus 5.5 (platform.claude.com pricing, 2026-09-22): $4 input,
  // $20 output, $5 5-minute cache writes and $0.20 cache reads per MTok, so
  // cache hits cost 0.05x base input instead of the usual 0.1x.
  // 100k in + 100k out + 1M cache reads + 100k cache writes:
  //   Opus 5.5: 0.4 + 2.0 + 0.2 + 0.5   = 3.1
  //   Opus 5:   0.5 + 2.5 + 0.5 + 0.625 = 4.125
  const withCache = (model: string, provider?: string): ModelUsage => ({
    ...usage(model),
    ...(provider !== undefined ? { provider } : {}),
    cachedInputTokens: 1_000_000,
    cacheCreationInputTokens: 100_000,
  });

  it.each([
    ["claude-opus-5-5", undefined, "claude-opus-5-5"],
    ["claude-opus-5-5", "anthropic", "anthropic:claude-opus-5-5"],
  ])("prices %s (provider %s) on the Opus 5.5 tier", (model, provider, key) => {
    const result = computeUsdCostWithResolution(
      withCache(model, provider),
      DEFAULT_MODEL_COSTS,
    );
    expect(result.known).toBe(true);
    expect(result.matchedKey).toBe(key);
    expect(result.costUsd).toBeCloseTo(3.1, 6);
  });

  it("bills Opus 5.5 cache reads at 5% of input, half of Opus 5's 10%", () => {
    const readsOnly = (model: string): ModelUsage => ({
      ...usage(model),
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
      totalTokens: 1_000_000,
    });
    expect(computeUsdCost(readsOnly("claude-opus-5-5"), DEFAULT_MODEL_COSTS))
      .toBeCloseTo(0.2, 6);
    expect(computeUsdCost(readsOnly("claude-opus-5"), DEFAULT_MODEL_COSTS))
      .toBeCloseTo(0.5, 6);
  });

  it("keeps Claude Opus 5 on the 5-over-25 tier", () => {
    const result = computeUsdCostWithResolution(
      withCache("claude-opus-5"),
      DEFAULT_MODEL_COSTS,
    );
    expect(result.matchedKey).toBe("claude-opus-5");
    expect(result.costUsd).toBeCloseTo(4.125, 6);
  });

  // M-COST-2: the background-agent dollar_cap path calls computeUsdCost(usage,
  // DEFAULT_MODEL_COSTS) directly (background-agent-runner.ts). Pin that this
  // function — not just the resolution wrapper the sidecar uses — also prices
  // opus-4-8 at $5/$25, so dollar_cap gates at the real cost.
  it("computeUsdCost (dollar_cap path) prices opus-4-8 at $5/$25", () => {
    expect(computeUsdCost(usage("claude-opus-4-8"), DEFAULT_MODEL_COSTS)).toBeCloseTo(
      EXPECTED_5_25,
      6,
    );
  });
});
