import { expect, test } from "vitest";
import { conservativeModelCost, DEFAULT_MODEL_COSTS, computeUsdCostWithResolution, type ModelCostEntry } from "../../src/session/cost.js";

test.each([
  ["anthropic", 1000, 0, 0.36],
  ["anthropic", 0, 1000, 0.36],
  ["anthropic", 600, 400, 0.36],
  ["bedrock", 600, 400, 0.36],
  ["openai", 600, 400, 0.21],
] as const)("normalizes unpriced %s cache reads %i and writes %i", (provider, cachedInputTokens, cacheCreationInputTokens, costUsd) => {
  const result = computeUsdCostWithResolution({
    provider, model: "unpriced-model", inputTokens: 1000, outputTokens: 100,
    cachedInputTokens, cacheCreationInputTokens, reasoningOutputTokens: 0,
    webSearchRequests: 0, totalTokens: 1100, turns: 1,
  }, DEFAULT_MODEL_COSTS);
  expect(result).toMatchObject({ known: false, costEstimated: true });
  expect(result.costUsd).toBeCloseTo(costUsd, 9);
});

test.each([
  ["nvidia-nim", "nvidia/llama-3.1-nemotron-70b-instruct", 500, 0, 0.21],
  ["nvidia-nim", "nvidia/llama-3.1-nemotron-70b-instruct", 0, 500, 0.21],
  ["nvidia-nim", "nvidia/llama-3.1-nemotron-70b-instruct", 300, 200, 0.21],
  ["amazon-bedrock", "amazon.nova-pro-v1:0", 300, 200, 0.285],
] as const)("uses provider cache semantics for matched %s/%s fallback with %i reads and %i writes", (provider, model, cachedInputTokens, cacheCreationInputTokens, costUsd) => {
  const result = computeUsdCostWithResolution({
    provider, model, inputTokens: 1000, outputTokens: 100,
    cachedInputTokens, cacheCreationInputTokens, reasoningOutputTokens: 0,
    webSearchRequests: 0, totalTokens: 1100, turns: 1,
  }, DEFAULT_MODEL_COSTS);
  expect(result).toMatchObject({ known: false, costEstimated: true });
  expect(result.matchedKey).toBeDefined();
  expect(result.costUsd).toBeCloseTo(costUsd, 9);
});

test("fallback dominates every token rate including nested fast and long-context tiers", () => {
  const fallback = conservativeModelCost();
  const check = (entry: ModelCostEntry) => {
    expect(fallback.inputUsdPer1K).toBeGreaterThanOrEqual(entry.inputUsdPer1K);
    expect(fallback.outputUsdPer1K).toBeGreaterThanOrEqual(entry.outputUsdPer1K);
    expect(fallback.cachedInputUsdPer1K!).toBeGreaterThanOrEqual(entry.cachedInputUsdPer1K ?? 0);
    expect(fallback.cacheCreationUsdPer1K!).toBeGreaterThanOrEqual(entry.cacheCreationUsdPer1K ?? 0);
    if (entry.fastMode) check(entry.fastMode);
    if (entry.longContext) check(entry.longContext.rates);
  };
  Object.values(DEFAULT_MODEL_COSTS).forEach(check);
  expect(conservativeModelCost({ future: { inputUsdPer1K: 1, outputUsdPer1K: 2, fastMode: { inputUsdPer1K: 3, outputUsdPer1K: 4 } } }))
    .toMatchObject({ inputUsdPer1K: 3, outputUsdPer1K: 4, cachedInputUsdPer1K: 3 });
});

test.each(["1.1", "1.2", "1.3", "1.2-contributor", "1.3-contributor"])("prices Meta %s cached usage without estimating", version => {
  const result = computeUsdCostWithResolution({provider: "meta", model: `muse-spark-${version}`,
    inputTokens: 1000, outputTokens: 1000, cachedInputTokens: 500, cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: 2000, turns: 1}, DEFAULT_MODEL_COSTS);
  expect(result.known).toBe(true);
  expect(result.costEstimated).toBeUndefined();
  expect(result.costUsd).toBeCloseTo(version.endsWith("contributor") ? 0.000251 : 0.00495, 9);
});


test.each([
  ["qwen", "qwen3.8-max", 0.002, 0.006, 0.00025],
  ["ollama-cloud", "deepseek-v4.1-flash", 0.0003, 0.0012, 0.000006],
] as const)("prices the %s default at its own published tariff", (provider, model, input, output, cached) => {
  const result = computeUsdCostWithResolution({provider, model, inputTokens: 1000, outputTokens: 1000,
    cachedInputTokens: 500, cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
    webSearchRequests: 0, totalTokens: 2000, turns: 1}, DEFAULT_MODEL_COSTS);
  expect(result.known).toBe(true);
  expect(result.costUsd).toBeCloseTo(input / 2 + cached / 2 + output, 9);
});

test("does not borrow a native tariff for future Meta releases or subscription endpoints", () => {
  for (const [provider, model] of [["meta", "muse-spark-1.4"], ["qwen-token-plan", "qwen3.8-max"], ["zai-coding-plan", "glm-5.3"]]) {
    expect(computeUsdCostWithResolution({provider: provider!, model: model!, inputTokens: 1000, outputTokens: 1000,
      cachedInputTokens: 500, cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
      webSearchRequests: 0, totalTokens: 2000, turns: 1}, DEFAULT_MODEL_COSTS))
      .toMatchObject({known: false, costEstimated: true, costUsd: 0.75});
  }
});
