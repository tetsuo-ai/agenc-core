import { describe, expect, test } from "vitest";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS, resolveModelCostEntry, type ModelUsage } from "../../src/session/cost.js";

const usage = (provider: string | undefined, model: string): ModelUsage => ({
  ...(provider === undefined ? {} : { provider }), model,
  inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0,
  cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
  webSearchRequests: 0, totalTokens: 1100, turns: 1,
});

describe("independent local-zero authority matrix", () => {
  test.each(["ollama-cloud", "deepseek", "zai"].flatMap(provider =>
    ["ollama:synthetic", "lmstudio:synthetic", "ollama", "lmstudio", "openai-compatible"]
      .map(model => [provider, model] as const),
  ))("does not attribute local free inference to %s with model %s", (provider, model) => {
    const input = usage(provider, model);
    expect(resolveModelCostEntry(input, DEFAULT_MODEL_COSTS)).toBeNull();
    expect(computeUsdCostWithResolution(input, DEFAULT_MODEL_COSTS).known).toBe(false);
  });

  test.each(["ollama", "lmstudio", "openai-compatible"])(
    "keeps current local provider behavior for %s", (provider) => {
      expect(computeUsdCostWithResolution(usage(provider, "synthetic"), DEFAULT_MODEL_COSTS))
        .toMatchObject({ known: true, costUsd: 0, matchedKey: provider });
    },
  );

  test.each(["ollama:synthetic", "lmstudio:synthetic"])(
    "preserves existing unattributed shorthand %s", (model) => {
      expect(computeUsdCostWithResolution(usage(undefined, model), DEFAULT_MODEL_COSTS))
        .toMatchObject({ known: true, costUsd: 0 });
    },
  );

  test.each(["ollama:synthetic", "lmstudio:synthetic", "openai-compatible"])(
    "honors an explicit audited hosted entry for %s", (model) => {
      const key = `ollama-cloud:${model}`;
      const registry = { ...DEFAULT_MODEL_COSTS, [key]: {
        inputUsdPer1K: 0.01, outputUsdPer1K: 0.02,
      } };
      expect(computeUsdCostWithResolution(usage("ollama-cloud", model), registry))
        .toMatchObject({ known: true, costUsd: 0.012, matchedKey: key });
    },
  );

  test("normalizes explicit provider and local-prefix case", () => {
    expect(computeUsdCostWithResolution(
      usage(" OLLAMA-CLOUD ", " OLLAMA:synthetic "), DEFAULT_MODEL_COSTS,
    ).known).toBe(false);
  });
});
