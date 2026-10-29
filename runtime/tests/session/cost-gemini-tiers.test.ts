// Gemini rows from the paid Standard table of
// ai.google.dev/gemini-api/docs/pricing, read 2026-10-28. promptTokenCount
// includes the implicit-cache hits reported as cachedContentTokenCount, so the
// cached share bills at the cached rate, and the Pro models bill a prompt over
// 200K tokens at their long-context rates. Several rows are introductory and
// change on a date the page announces, so every price here names the moment
// it is billed.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeUsdCostWithResolution,
  conservativeModelCost,
  CostSidecar,
  DEFAULT_MODEL_COSTS,
  resolveModelCostEntry,
  type ModelUsage,
} from "../../src/session/cost.js";

const OCT_28_2026 = Date.parse("2026-10-28T12:00:00Z");
const ARGON_CHANGE = Date.parse("2026-12-01T00:00:00Z");
const FLASH_CHANGE = Date.parse("2027-01-01T00:00:00Z");

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
    pricedAtMs: OCT_28_2026,
    ...extra,
  };
}

function priced(usage: ModelUsage) {
  return computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Gemini standard rates", () => {
  it.each([
    // model, USD for 100K input and 10K output on 2026-10-28
    ["gemini-4-argon", 0.3],
    ["gemini-3.1-pro-preview", 0.32],
    ["gemini-3.8-flash", 0.1125],
    ["gemini-3.7-flash", 0.1125],
    ["gemini-3.6-flash", 0.1125],
    // Deprecated: Google serves gemini-3.5-flash with gemini-3.6-flash
    // (changelog 2026-10-08), and the page lists no 3.5 Flash price.
    ["gemini-3.5-flash", 0.1125],
    ["gemini-3.5-flash-lite", 0.055],
    ["gemini-3.1-flash-lite", 0.04],
    ["gemini-3-flash-preview", 0.08],
    ["gemini-robotics-er-2-preview", 0.15],
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
    // 3.5 Flash bills as 3.6 Flash: the same rates as 3.8 Flash.
    expect(
      priced(call("gemini-3.5-flash", 100_000, 1_000, { cachedInputTokens: 80_000 })).costUsd,
    ).toBeCloseTo(0.02475, 9);
    // Gemini 4 Argon: 20K at $2, 80K cached at $0.10 (95% off), 1K at $10.
    expect(
      priced(call("gemini-4-argon", 100_000, 1_000, { cachedInputTokens: 80_000 })).costUsd,
    ).toBeCloseTo(0.058, 9);
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

  it("has no long-context tier on the Flash and Argon rows", () => {
    expect(priced(call("gemini-3.8-flash", 300_000, 10_000)).costUsd).toBeCloseTo(0.2625, 9);
    // 300K * 2 + 10K * 10: Argon has one rate at every prompt size.
    expect(priced(call("gemini-4-argon", 300_000, 10_000)).costUsd).toBeCloseTo(0.7, 9);
  });
});

describe("Gemini prices that change on an announced date", () => {
  it.each([
    // model, last moment of the old price, first moment of the new one,
    // USD for 100K input and 10K output before and after
    ["gemini-4-argon", ARGON_CHANGE, 0.3, 0.6],
    ["gemini-3.8-flash", FLASH_CHANGE, 0.1125, 0.225],
    ["gemini-3.7-flash", FLASH_CHANGE, 0.1125, 0.225],
    ["gemini-3.6-flash", FLASH_CHANGE, 0.1125, 0.225],
    ["gemini-3.5-flash", FLASH_CHANGE, 0.1125, 0.225],
    ["gemini-robotics-er-2-preview", FLASH_CHANGE, 0.15, 0.3],
  ] as const)("switches %s at 00:00 UTC on the first day of the new price", (model, changeAt, before, after) => {
    expect(priced(call(model, 100_000, 10_000, { pricedAtMs: changeAt - 1 }))).toMatchObject({
      costUsd: expect.closeTo(before, 9),
      known: true,
    });
    expect(priced(call(model, 100_000, 10_000, { pricedAtMs: changeAt }))).toMatchObject({
      costUsd: expect.closeTo(after, 9),
      known: true,
    });
  });

  it("bills cached input at the new cached rate after the change", () => {
    // Argon from 2026-12-01: 20K at $4, 80K cached at $0.20, 1K at $20.
    expect(
      priced(call("gemini-4-argon", 100_000, 1_000, {
        cachedInputTokens: 80_000,
        pricedAtMs: ARGON_CHANGE,
      })).costUsd,
    ).toBeCloseTo(0.116, 9);
  });

  it("prices at the current time when the usage names no moment", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: ARGON_CHANGE + 86_400_000 });
    expect(priced(call("gemini-4-argon", 100_000, 10_000, { pricedAtMs: undefined })).costUsd)
      .toBeCloseTo(0.6, 9);
    expect(resolveModelCostEntry({ provider: "gemini", model: "gemini-4-argon" }, DEFAULT_MODEL_COSTS))
      .toMatchObject({ key: "gemini:gemini-4-argon", dated: true, entry: { inputUsdPer1K: 0.004, outputUsdPer1K: 0.02 } });
  });

  it("shows the rates in effect to price displays and admission", () => {
    const before = resolveModelCostEntry(
      { provider: "gemini", model: "gemini-3.8-flash", pricedAtMs: OCT_28_2026 },
      DEFAULT_MODEL_COSTS,
    );
    const after = resolveModelCostEntry(
      { provider: "gemini", model: "gemini-3.8-flash", pricedAtMs: FLASH_CHANGE },
      DEFAULT_MODEL_COSTS,
    );
    expect(before?.entry).toMatchObject({ inputUsdPer1K: 0.00075, outputUsdPer1K: 0.00375, cachedInputUsdPer1K: 0.000075 });
    expect(after?.entry).toMatchObject({ inputUsdPer1K: 0.0015, outputUsdPer1K: 0.0075, cachedInputUsdPer1K: 0.00015 });
    // A row without an announced change reports no date dependence.
    expect(resolveModelCostEntry({ provider: "gemini", model: "gemini-2.5-pro" }, DEFAULT_MODEL_COSTS))
      .not.toHaveProperty("dated");
  });

  it("bounds unknown models by the announced later rates too", () => {
    // Rates above every registry row and the unknown-model fallback, so only
    // the later tier can produce this ceiling.
    expect(conservativeModelCost({ "x:y": { inputUsdPer1K: 0.001, outputUsdPer1K: 0.001,
      priceChange: { effectiveFromMs: ARGON_CHANGE, rates: { inputUsdPer1K: 0.9, outputUsdPer1K: 0.9 } } } }))
      .toMatchObject({ inputUsdPer1K: 0.9, outputUsdPer1K: 0.9 });
  });

  it("keeps each call of a session at the rate of the moment it billed", () => {
    const sidecar = new CostSidecar({ defaultProvider: "gemini", defaultModel: "gemini-4-argon", exitSummary: false });
    const tokenCount = (seq: number) => sidecar.onEvent({
      id: String(seq),
      seq,
      msg: {
        type: "token_count",
        payload: { provider: "gemini", model: "gemini-4-argon", promptTokens: 100_000, completionTokens: 10_000, totalTokens: 110_000 },
      },
    });
    vi.useFakeTimers({ toFake: ["Date"], now: ARGON_CHANGE - 60_000 });
    tokenCount(1);
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(0.3, 9);
    vi.setSystemTime(ARGON_CHANGE + 60_000);
    // The first call is not repriced when the price changes.
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(0.3, 9);
    tokenCount(2);
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(0.9, 9);
    expect(sidecar.hasUnknownModelCost()).toBe(false);
  });
});

describe("Gemini models without a price row", () => {
  it.each(["gemini-4-xenon", "gemini-4-argon-preview", "gemini-3.9-flash"])(
    "never borrows another model's price for %s",
    (model) => {
      expect(resolveModelCostEntry({ provider: "gemini", model }, DEFAULT_MODEL_COSTS)).toBeNull();
      const result = priced(call(model, 100_000, 10_000));
      expect(result.known).toBe(false);
      expect(result.costEstimated).toBe(true);
      expect(result).not.toHaveProperty("matchedKey");
    },
  );
});
