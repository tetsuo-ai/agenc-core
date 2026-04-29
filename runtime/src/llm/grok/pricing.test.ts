import { describe, expect, it } from "vitest";

import { computeGrokCallCostUsd, getGrokModelPricing } from "./pricing.js";

describe("getGrokModelPricing", () => {
  it("returns the catalog price for a canonical 4.20 model", () => {
    expect(getGrokModelPricing("grok-4.20-0309-non-reasoning")).toEqual({
      inputPricePer1M: 2.0,
      outputPricePer1M: 6.0,
    });
  });

  it("returns the catalog price for a 4-1-fast model", () => {
    expect(getGrokModelPricing("grok-4-1-fast-reasoning")).toEqual({
      inputPricePer1M: 0.2,
      outputPricePer1M: 0.5,
    });
  });

  it("resolves legacy beta-infixed IDs through the canonical alias map", () => {
    expect(getGrokModelPricing("grok-4.20-beta-0309-non-reasoning")).toEqual({
      inputPricePer1M: 2.0,
      outputPricePer1M: 6.0,
    });
    expect(getGrokModelPricing("grok-4.20-multi-agent-beta-0309")).toEqual({
      inputPricePer1M: 2.0,
      outputPricePer1M: 6.0,
    });
  });

  it("returns undefined for unpriced or unknown models", () => {
    expect(getGrokModelPricing("grok-3-mini")).toBeUndefined();
    expect(getGrokModelPricing("grok-unknown-model")).toBeUndefined();
    expect(getGrokModelPricing("")).toBeUndefined();
    expect(getGrokModelPricing(undefined)).toBeUndefined();
  });
});

describe("computeGrokCallCostUsd", () => {
  it("splits input and output pricing for a 4.20 model", () => {
    // 1k prompt * $2/1M + 500 completion * $6/1M = 0.002 + 0.003 = 0.005
    expect(
      computeGrokCallCostUsd(
        { promptTokens: 1_000, completionTokens: 500 },
        "grok-4.20-0309-reasoning",
      ),
    ).toBe(0.005);
  });

  it("uses fast pricing for 4-1-fast models", () => {
    // 1M prompt * $0.20/1M + 1M completion * $0.50/1M = 0.20 + 0.50 = 0.70
    expect(
      computeGrokCallCostUsd(
        { promptTokens: 1_000_000, completionTokens: 1_000_000 },
        "grok-4-1-fast-non-reasoning",
      ),
    ).toBe(0.7);
  });

  it("returns undefined for unpriced models (callers should skip, not show $0)", () => {
    expect(
      computeGrokCallCostUsd(
        { promptTokens: 1_000, completionTokens: 500 },
        "grok-3-mini",
      ),
    ).toBeUndefined();
  });

  it("treats missing/negative tokens as zero", () => {
    expect(
      computeGrokCallCostUsd(
        { promptTokens: NaN, completionTokens: -5 },
        "grok-4.20-0309-non-reasoning",
      ),
    ).toBe(0);
  });
});
