// Providers that count cached prompt tokens inside the prompt tokens they
// report must bill the cached part once, at the cached rate. xAI documents
// this ("prompt_tokens: 125 with cached_tokens: 98"), and its billed cost
// agrees: across 98 real grok-4.7 requests the response's cost_in_usd_ticks
// fits uncached:cached:output = 1 : 0.25 : 3 exactly, the ratio of the
// $2 / $0.50 / $6 list rates applied to (prompt - cached, cached, output).
// MiniMax is served over Chat Completions, whose prompt_tokens also include
// cached_tokens.
import { describe, expect, it } from "vitest";

import {
  computeUsdCostWithResolution,
  CostSidecar,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "../../src/session/cost.js";
import type { Event } from "../../src/session/event-log.js";

const PER_M = 1 / 1_000_000;

function call(
  model: string,
  provider: string,
  input: number,
  cached: number,
  output: number,
  extra: Partial<ModelUsage> = {},
): ModelUsage {
  return {
    model,
    provider,
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    totalTokens: input + output,
    turns: 1,
    singleCall: true,
    ...extra,
  };
}

function usd(usage: ModelUsage): number {
  return computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS).costUsd;
}

describe("cached prompt tokens that are part of the reported prompt", () => {
  it.each(["grok-4.7", "grok-4.6", "grok-4.5", "xai:grok-4.7"])(
    "bills a cached %s call once, at the cached rate",
    (model) => {
      // A real grok-4.7 request: 55,500 prompt tokens of which 47,872 cached,
      // 938 output tokens.
      expect(usd(call(model, "grok", 55_500, 47_872, 938))).toBeCloseTo(
        (55_500 - 47_872) * 2 * PER_M + 47_872 * 0.5 * PER_M + 938 * 6 * PER_M,
        12,
      );
    },
  );

  it("keeps a fully cached Grok call below the price of the same call uncached", () => {
    const cold = usd(call("grok-4.7", "grok", 100_000, 0, 1_000));
    const warm = usd(call("grok-4.7", "grok", 100_000, 100_000, 1_000));
    expect(warm).toBeLessThan(cold);
    expect(warm).toBeCloseTo(100_000 * 0.5 * PER_M + 1_000 * 6 * PER_M, 12);
  });

  it("bills a priority-served cached Grok call at twice the standard price", () => {
    const standard = call("grok-4.7", "grok", 100_000, 60_000, 10_000);
    expect(usd({ ...standard, speed: "fast" })).toBeCloseTo(
      (40_000 * 4 + 60_000 * 1 + 10_000 * 12) * PER_M,
      12,
    );
  });

  it.each(["MiniMax-M3", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"])(
    "bills a cached %s call once, at the cached rate",
    (model) => {
      const entry = DEFAULT_MODEL_COSTS[model]!;
      expect(usd(call(model, "minimax", 50_000, 45_000, 500))).toBeCloseTo(
        (5_000 * entry.inputUsdPer1K + 45_000 * entry.cachedInputUsdPer1K! + 500 * entry.outputUsdPer1K) / 1000,
        12,
      );
    },
  );
});

describe("CostSidecar totals for cached Grok calls", () => {
  const tokenCount = (promptTokens: number, cachedInputTokens: number, completionTokens: number): Event => ({
    id: "usage",
    msg: {
      type: "token_count",
      payload: {
        model: "grok-4.7",
        provider: "grok",
        promptTokens,
        cachedInputTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    },
  } as Event);

  it("sums each call at its cached and uncached rates", () => {
    const sidecar = new CostSidecar();
    sidecar.onEvent(tokenCount(20_099, 1_152, 84));
    sidecar.onEvent(tokenCount(55_500, 47_872, 938));
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(
      ((20_099 - 1_152) * 2 + 1_152 * 0.5 + 84 * 6) * PER_M +
        ((55_500 - 47_872) * 2 + 47_872 * 0.5 + 938 * 6) * PER_M,
      12,
    );
  });
});
