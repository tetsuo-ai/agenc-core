import { describe, expect, test } from "vitest";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { buildOpenAIResponsesRequest } from "../../../src/llm/wire/responses-openai.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS } from "../../../src/session/cost.js";

const efforts = ["low", "medium", "high", "xhigh", "max"] as const;

describe.each([
  { model: "gpt-6.2-astra", label: "GPT-6.2 Astra", shortCost: 1.108, longCost: 5.216 },
  { model: "gpt-6.2-sol", label: "GPT-6.2 Sol", shortCost: 0.277, longCost: 1.304 },
])("$label", ({ model, label, shortCost, longCost }) => {
  test("advertises the documented limits, modalities and single-model efforts", () => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model })).toMatchObject({
      displayName: label, contextWindow: 1_050_000, maxContextWindow: 1_050_000,
      maxOutputTokens: 128_000, supportedReasoningLevels: efforts,
      supportsToolUse: true, supportsStructuredOutput: true,
      inputModalities: ["text", "image"], additionalSpeedTiers: ["fast"],
    });
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: model + "-pro" })).toBeUndefined();
    expect(resolveRegisteredModelCatalogEntry({ provider: "other", model })).toBeUndefined();
  });

  test.each(efforts)("preserves effort %s on the platform and sign-in routes", effort => {
    for (const chatgptBackend of [false, true]) {
      const request = buildOpenAIResponsesRequest({
        model, messages: [{ role: "user", content: "hello" }], tools: [], chatgptBackend,
        options: { reasoningEffort: effort, temperature: 0.2, maxOutputTokens: 128 },
      });
      expect(request.model).toBe(model);
      expect(request.reasoning?.effort).toBe(effort);
      expect(request).not.toHaveProperty("temperature");
      if (chatgptBackend) {
        expect(request.store).toBe(false);
        expect(request.include).toContain("reasoning.encrypted_content");
        expect(request).not.toHaveProperty("max_output_tokens");
      } else {
        expect(request.max_output_tokens).toBe(128);
      }
    }
  });

  test("prices input, cache reads, cache writes and output at Standard and Fast rates", () => {
    for (const [inputTokens, standardCost] of [[100_000, shortCost], [300_000, longCost]] as const) {
      const usage = {
        provider: "openai", model, inputTokens, outputTokens: 10_000,
        cachedInputTokens: 20_000, cacheCreationInputTokens: 30_000,
        reasoningOutputTokens: 4_000, webSearchRequests: 0, totalTokens: inputTokens + 10_000,
        turns: 1, singleCall: true,
      };
      expect(computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS)).toMatchObject({
        known: true, costUsd: expect.closeTo(standardCost, 9),
      });
      expect(computeUsdCostWithResolution({ ...usage, speed: "fast" }, DEFAULT_MODEL_COSTS)).toMatchObject({
        known: true, costUsd: expect.closeTo(standardCost * 2, 9),
      });
      expect(computeUsdCostWithResolution({ ...usage, billingMode: "plan" }, DEFAULT_MODEL_COSTS))
        .toEqual({ known: true, costUsd: 0 });
      expect(computeUsdCostWithResolution({ ...usage, provider: "other" }, DEFAULT_MODEL_COSTS).known).toBe(false);
    }
  });
});
