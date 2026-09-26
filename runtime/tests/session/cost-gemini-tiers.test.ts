// Gemini rows from the paid Standard table of
// ai.google.dev/gemini-api/docs/pricing, read 2026-09-26. promptTokenCount
// includes the implicit-cache hits reported as cachedContentTokenCount, so the
// cached share bills at the cached rate, and the Pro models bill a prompt over
// 200K tokens at their long-context rates.
import { describe, expect, it } from "vitest";

import {
  computeUsdCostWithResolution,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "../../src/session/cost.js";

function call(
  model: string,
  input: number,
  output: number,
  extra: Partial<ModelUsage> = {},
): ModelUsage {
  return {
    model,
    provider: "gemini",
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    totalTokens: input + output,
    turns: 1,
    singleCall: true,
    ...extra,
  };
}

function priced(usage: ModelUsage) {
  return computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS);
}

describe("Gemini standard rates", () => {
  it.each([
    // model, USD for 100K input and 10K output
    ["gemini-3.1-pro-preview", 0.32],
    ["gemini-3.8-flash", 0.1125],
    ["gemini-3.7-flash", 0.1125],
    ["gemini-3.6-flash", 0.1125],
    ["gemini-3.5-flash", 0.24],
    ["gemini-3.5-flash-lite", 0.055],
    ["gemini-3.1-flash-lite", 0.04],
    ["gemini-3-flash-preview", 0.08],
    ["gemini-2.5-pro", 0.225],
    ["gemini-2.5-flash", 0.055],
    ["gemini-2.5-flash-lite", 0.014],
  ])("prices %s at %d", (model, usd) => {
    expect(priced(call(model, 100_000, 10_000))).toEqual({
      costUsd: expect.closeTo(usd, 9),
      known: true,
      matchedKey: `gemini:${model}`,
    });
  });
});

describe("Gemini implicit cache hits", () => {
  it("bills the cached share of the prompt at the cached rate", () => {
    // 3.8 Flash: 20K fresh at $0.75, 80K cached at $0.075, 1K out at $3.75.
    expect(
      priced(call("gemini-3.8-flash", 100_000, 1_000, { cachedInputTokens: 80_000 })).costUsd,
    ).toBeCloseTo(0.02475, 9);
    // 3.5 Flash: 20K at $1.50, 80K at $0.15, 1K at $9.
    expect(
      priced(call("gemini-3.5-flash", 100_000, 1_000, { cachedInputTokens: 80_000 })).costUsd,
    ).toBeCloseTo(0.051, 9);
  });
});

describe("Gemini Pro long-context rates apply per request above 200K", () => {
  it("bills a single 3.1 Pro request over 200K at the long rates", () => {
    // $4 input and $18 output per 1M: 300K * 4 + 10K * 18.
    expect(priced(call("gemini-3.1-pro-preview", 300_000, 10_000)).costUsd).toBeCloseTo(1.38, 9);
    // Cached input over 200K is $0.40: 50K * 4 + 250K * 0.4 + 10K * 18.
    expect(
      priced(
        call("gemini-3.1-pro-preview", 300_000, 10_000, { cachedInputTokens: 250_000 }),
      ).costUsd,
    ).toBeCloseTo(0.48, 9);
    // 2.5 Pro: $2.50 input and $15 output per 1M above 200K.
    expect(priced(call("gemini-2.5-pro", 300_000, 10_000)).costUsd).toBeCloseTo(0.9, 9);
  });

  it("keeps the standard rates at 200K and for accumulated usage", () => {
    expect(priced(call("gemini-3.1-pro-preview", 200_000, 10_000)).costUsd).toBeCloseTo(0.52, 9);
    expect(
      priced(call("gemini-3.1-pro-preview", 300_000, 10_000, { singleCall: false })).costUsd,
    ).toBeCloseTo(0.72, 9);
  });

  it("has no long-context tier on the Flash rows", () => {
    expect(priced(call("gemini-3.8-flash", 300_000, 10_000)).costUsd).toBeCloseTo(0.2625, 9);
  });
});
