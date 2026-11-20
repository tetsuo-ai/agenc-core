import { describe, expect, it } from "vitest";
import { computeUsdCostWithResolution, CostSidecar, DEFAULT_MODEL_COSTS, type ModelUsage } from "../../src/session/cost.js";

// Ollama Cloud receipts, 2026-10-21: /api/balance and /api/usage reconcile
// only after each model request is rounded up to $0.00001, including cache hits.
const call = (input: number, output: number, cached = 0): ModelUsage => ({
  provider: "ollama-cloud", model: "deepseek-v4-pro:0813", inputTokens: input, outputTokens: output,
  cachedInputTokens: cached, cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
  webSearchRequests: 0, totalTokens: input + output, turns: 1, singleCall: true,
});

const first = call(5354, 87);
const second = call(5671, 114, 5354);

describe("Ollama Cloud per-request billing precision", () => {
  it("rounds the full input and cached input calls at the billing boundary", () => {
    expect(computeUsdCostWithResolution(first, DEFAULT_MODEL_COSTS).costUsd).toBe(0.00742);
    expect(computeUsdCostWithResolution(second, DEFAULT_MODEL_COSTS).costUsd).toBe(0.00111);
  });

  it("retains per-call rounding when the session combines multiple requests", () => {
    const sidecar = new CostSidecar({ exitSummary: false });
    for (const [index, usage] of [first, second].entries()) {
      sidecar.onEvent({ id: `call-${index}`, seq: index + 1, msg: { type: "token_count", payload: {
        provider: usage.provider, model: usage.model, promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens,
        totalTokens: usage.totalTokens,
      } } });
    }
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(0.00853, 12);
    expect(sidecar.getSessionModelUsage()[0]?.costUsd).toBeCloseTo(0.00853, 12);
  });

  // https://ollama.com/pricing, read 2026-11-20 (job w21-coremodels): Beam
  // has a row of its own and Mistral Large 4 moved from 0.68/0.07/2.09.
  it.each([
    ["beam", 0.125, 0.015, 0.4],
    ["mistral-large-4", 0.7, 0.07, 2.1],
  ] as const)("bills %s at the price list of 2026-11-20", (model, input, cached, output) => {
    const million = (inputTokens: number, outputTokens: number, cachedInputTokens = 0) =>
      computeUsdCostWithResolution({ ...call(inputTokens, outputTokens, cachedInputTokens), model }, DEFAULT_MODEL_COSTS);
    expect(million(1_000_000, 0)).toMatchObject({ known: true, costUsd: input, matchedKey: `ollama-cloud:${model}` });
    expect(million(0, 1_000_000).costUsd).toBe(output);
    expect(million(1_000_000, 0, 1_000_000).costUsd).toBe(cached);
  });

  it("keeps exact billing boundaries and a zero-usage call unchanged", () => {
    expect(computeUsdCostWithResolution({ ...call(1000, 0), model: "gemma4:31b" }, DEFAULT_MODEL_COSTS).costUsd)
      .toBe(0.00014);
    expect(computeUsdCostWithResolution(call(0, 0), DEFAULT_MODEL_COSTS).costUsd).toBe(0);
  });

  it("preserves a reported charge and another provider's precision", () => {
    expect(computeUsdCostWithResolution({ ...first, providerCostUsd: 0.0074118 }, DEFAULT_MODEL_COSTS).costUsd)
      .toBe(0.0074118);
    // Beam is no longer free: 5,354 input and 87 output tokens round up to $0.00071.
    expect(computeUsdCostWithResolution({ ...first, model: "beam" }, DEFAULT_MODEL_COSTS).costUsd).toBe(0.00071);
    const venice = { ...first, provider: "venice", model: "other-host" };
    const registry = { "venice:other-host": { inputUsdPer1K: 0.00132, outputUsdPer1K: 0.00396 } };
    expect(computeUsdCostWithResolution(venice, registry).costUsd).toBeCloseTo(0.0074118, 12);
  });
});
