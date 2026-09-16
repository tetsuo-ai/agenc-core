import { describe, expect, test } from "vitest";
import {
  computeUsdCostWithResolution,
  DEFAULT_MODEL_COSTS,
  resolveModelCostEntry,
  type ModelUsage,
} from "../../src/session/cost.js";
import { OLLAMA_CLOUD_MODELS } from "../../src/llm/registry/ollama-cloud-models.js";

const usage = (provider: string, model: string): ModelUsage => ({
  provider, model, inputTokens: 1_000, outputTokens: 500,
  cachedInputTokens: 0, cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0, webSearchRequests: 0,
  totalTokens: 1_500, turns: 1,
});

describe("independent Ollama Cloud cost authority review", () => {
  // This does not prescribe a rate or require all Cloud models to be known.
  // A hosted route can use its own audited rate or stay unknown, but cannot
  // claim the upstream vendor's different tariff through a bare model alias.
  test.each(OLLAMA_CLOUD_MODELS.map(entry => entry.model))(
    "does not inherit another host's price for %s", (model) => {
      const input = usage("ollama-cloud", model);
      const match = resolveModelCostEntry(input, DEFAULT_MODEL_COSTS);
      const resolution = computeUsdCostWithResolution(input, DEFAULT_MODEL_COSTS);
      if (match === null) {
        expect(resolution.known).toBe(false);
      } else {
        expect(match.key).toBe(`ollama-cloud:${model}`);
        expect(match.entry.localZeroCost).not.toBe(true);
      }
    },
  );

  test("keeps an unlisted Cloud model unknown instead of local zero cost", () => {
    const input = usage("ollama-cloud", "ollama:synthetic-unlisted-model");
    expect(resolveModelCostEntry(input, DEFAULT_MODEL_COSTS)).toBeNull();
    expect(computeUsdCostWithResolution(input, DEFAULT_MODEL_COSTS).known).toBe(false);
  });

  test("retains known zero API cost for the real local provider", () => {
    expect(computeUsdCostWithResolution(
      usage("ollama", "synthetic-local-model"), DEFAULT_MODEL_COSTS,
    )).toMatchObject({ known: true, costUsd: 0, matchedKey: "ollama" });
  });

  test("retains direct MiniMax pricing on the actual MiniMax route", () => {
    const resolution = computeUsdCostWithResolution(
      usage("minimax", "MiniMax-M3"), DEFAULT_MODEL_COSTS,
    );
    expect(resolution.known).toBe(true);
    expect(resolution.matchedKey).toBe("minimax:MiniMax-M3");
    expect(resolution.costUsd).toBeGreaterThan(0);
  });
});
