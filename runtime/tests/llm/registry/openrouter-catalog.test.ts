import { describe, expect, test } from "vitest";
import { BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../../src/llm/registry/provider-info.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { OPENROUTER_MODELS } from "../../../src/llm/registry/openrouter-models.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS } from "../../../src/session/cost.js";
import { buildChatCompletionsRequest } from "../../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import { mergeProviderModelLayer } from "../../../src/config/provider-model-authority.js";

const cost = (model: string, inputTokens = 1000) => computeUsdCostWithResolution({
  provider: "openrouter", model, inputTokens, outputTokens: 1000,
  cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
  webSearchRequests: 0, totalTokens: inputTokens + 1000, turns: 1, singleCall: true,
}, DEFAULT_MODEL_COSTS);

describe("reviewed OpenRouter catalog", () => {
  test("serializes only advertised efforts in OpenRouter's nested envelope", () => {
    const model = "openai/gpt-oss-120b";
    const request = (reasoningEffort: "low" | "none") => buildChatCompletionsRequest({
      model, messages: [], tools: [], options: { reasoningEffort },
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("openrouter", model),
    });
    expect(request("low").reasoning).toEqual({ effort: "low" });
    expect(request("low")).not.toHaveProperty("reasoning_effort");
    expect(request("none")).not.toHaveProperty("reasoning");
    const managed = buildChatCompletionsRequest({ model, messages: [], tools: [],
      options: { reasoningEffort: "low" },
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("openrouter", model, { managedGateway: true }),
    });
    expect(managed).not.toHaveProperty("reasoning");
  });

  test.each(["nvidia-nim", "lmstudio", "ollama", "openai-compatible"])(
    "gateway names do not override explicit %s model selection", provider => {
      expect(mergeProviderModelLayer({}, {model_provider: provider, model: "moonshotai/kimi-k3"}))
        .toMatchObject({model_provider: provider, model: "moonshotai/kimi-k3"});
      expect(() => mergeProviderModelLayer({}, {model_provider: provider, model: "openrouter:moonshotai/kimi-k3"})).toThrow();
    });
  test("exposes current tool models without changing the configured default ordering", () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter[0]).toBe("x-ai/grok-4.5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter).toContain("anthropic/claude-sonnet-5.5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter).toContain("openai/gpt-6-sol");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter).not.toContain("poolside/laguna-xs.2:free");
    expect(OPENROUTER_MODELS.every(row => row.parameters.includes("tools") && !row.model.endsWith(":batch"))).toBe(true);
    expect(new Set(OPENROUTER_MODELS.map(row => row.model)).size).toBe(OPENROUTER_MODELS.length);
  });

  test("uses endpoint capability and limit metadata for the exact provider model", () => {
    expect(resolveRegisteredModelCatalogEntry({provider: "openrouter", model: "anthropic/claude-sonnet-5.5"})).toMatchObject({
      contextWindow: 1_000_000, maxOutputTokens: 128_000, inputModalities: ["text", "image"],
      supportsToolUse: true, supportedReasoningLevels: ["max", "xhigh", "high", "medium", "low"],
    });
    expect(resolveRegisteredModelCatalogEntry({provider: "openrouter", model: "openai/gpt-6-luna"})?.supportedReasoningLevels).toContain("none");
  });

  test("uses provider rates and long-context boundaries instead of upstream tariffs", () => {
    expect(cost("anthropic/claude-sonnet-5.5")).toMatchObject({known: true});
    expect(cost("anthropic/claude-sonnet-5.5").costUsd).toBeCloseTo(0.012);
    const row = OPENROUTER_MODELS.find(row => row.model === "openai/gpt-6-sol")!;
    const long = row.priceOverrides![0]!;
    expect(cost(row.model, long.min_prompt_tokens! - 1).costUsd).toBeCloseTo(
      (long.min_prompt_tokens! - 1) * Number(row.pricing.prompt) + 1000 * Number(row.pricing.completion), 9);
    expect(cost(row.model, long.min_prompt_tokens!).costUsd).toBeCloseTo(
      long.min_prompt_tokens! * Number(long.prompt) + 1000 * Number(long.completion), 9);
  });

  test("retains admission for unknown pricing without claiming it is free", () => {
    expect(cost("future-vendor/unpriced-model")).toMatchObject({known: false, costEstimated: true});
    expect(cost("future-vendor/unpriced-model").costUsd).toBeGreaterThan(0);
  });
});
