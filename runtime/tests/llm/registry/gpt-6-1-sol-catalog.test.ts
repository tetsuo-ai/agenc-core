import { describe, expect, test } from "vitest";
import { resolveRegisteredModelCatalogEntry, resolveModelCatalogMetadata } from "../../../src/llm/registry/model-catalog.js";
import { BUILT_IN_PROVIDER_DEFAULT_MODELS, BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../../src/llm/registry/provider-info.js";
import { resolveReasoningEffort } from "../../../src/llm/reasoning-effort.js";
import { buildOpenAIResponsesRequest } from "../../../src/llm/wire/responses-openai.js";
import { buildChatCompletionsRequest } from "../../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import { resolveSessionReasoningEffort } from "../../../src/session/session-reasoning-effort.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS, type ModelUsage } from "../../../src/session/cost.js";

const model = "gpt-6.1-sol";
const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
const priced = (extra: Partial<ModelUsage> = {}) => computeUsdCostWithResolution({
  provider: "openai", model, inputTokens: 100_000, outputTokens: 10_000,
  cachedInputTokens: 20_000, cacheCreationInputTokens: 30_000,
  reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: 110_000,
  turns: 1, singleCall: true, ...extra,
}, DEFAULT_MODEL_COSTS);

describe("GPT-6.1 Sol, official docs and live API reviewed 2026-09-29", () => {
  test("registers exact native and OpenRouter identities without changing defaults", () => {
    const native = resolveRegisteredModelCatalogEntry({ provider: "openai", model });
    expect(native).toMatchObject({ displayName: "GPT-6.1 Sol", contextWindow: 1_050_000,
      maxOutputTokens: 128_000, supportedReasoningLevels: efforts, defaultReasoningLevel: "medium",
      inputModalities: ["text", "image"], supportsToolUse: true, supportsStructuredOutput: true,
      additionalSpeedTiers: ["fast"], visibility: "list" });
    expect(resolveModelCatalogMetadata({ provider: "openai", model })).toMatchObject({
      contextWindow: 1_050_000, maxOutputTokens: 128_000, maxOutputTokensUpperLimit: 128_000,
    });
    expect(resolveRegisteredModelCatalogEntry({ provider: "openrouter", model: `openai/${model}` }))
      .toMatchObject({ contextWindow: 1_050_000, maxOutputTokens: 128_000,
        supportedReasoningLevels: [...efforts].reverse(), defaultReasoningLevel: "medium", supportsToolUse: true });
    for (const provider of ["openai", "openrouter"] as const) {
      const ids = BUILT_IN_PROVIDER_MODEL_CATALOG[provider];
      const prefix = provider === "openrouter" ? "openai/" : "";
      expect(ids.filter(id => id === prefix + model)).toHaveLength(1);
      expect(ids.indexOf(prefix + model)).toBeLessThan(ids.indexOf(prefix + "gpt-6-sol"));
    }
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.openai).toBe("gpt-5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openai[0]).toBe("gpt-5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter[0]).toBe("x-ai/grok-4.5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.github).not.toContain(`github:copilot:${model}`);
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: `${model}-pro` })).toBeUndefined();
    expect(resolveRegisteredModelCatalogEntry({ provider: "other", model })).toBeUndefined();
  });

  test.each(efforts)("preserves %s through native and OpenRouter request builders", effort => {
    const contract = resolveReasoningEffort({ provider: "openai", model });
    expect(contract).toMatchObject({ registered: true, levels: efforts, defaultLevel: "medium", acceptsChatEffort: true });
    const wire = resolveSessionReasoningEffort(effort, efforts, { provider: "openai", model });
    const body = buildOpenAIResponsesRequest({ model, messages: [], tools: [],
      options: { reasoningEffort: wire, temperature: 0.2, maxOutputTokens: 128, serviceTier: "priority" } });
    expect(body.reasoning?.effort).toBe(effort);
    expect(body).not.toHaveProperty("temperature");
    expect(body.max_output_tokens).toBe(128);
    expect(body.service_tier).toBe("priority");
    const routed = buildChatCompletionsRequest({ model: `openai/${model}`, messages: [], tools: [],
      options: { reasoningEffort: effort },
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("openrouter", `openai/${model}`) });
    expect(routed.reasoning).toEqual({ effort });
    expect(routed).not.toHaveProperty("reasoning_effort");
  });

  test("does not advertise or transmit unsupported none through session resolution", () => {
    expect(resolveSessionReasoningEffort("none", efforts, { provider: "openai", model })).toBeUndefined();
    const routed = buildChatCompletionsRequest({ model: `openai/${model}`, messages: [], tools: [],
      options: { reasoningEffort: "none" },
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("openrouter", `openai/${model}`) });
    expect(routed).not.toHaveProperty("reasoning");
  });

  test("prices cache reads at 5%, cache writes at 1.25x, and Fast at 2x", () => {
    // 50K uncached + 20K cached + 30K written + 10K output.
    expect(priced()).toMatchObject({ known: true, costUsd: expect.closeTo(0.277, 9) });
    expect(priced({ speed: "fast" })).toMatchObject({ known: true, costUsd: expect.closeTo(0.554, 9) });
    expect(priced({ inputTokens: 300_000 })).toMatchObject({ known: true, costUsd: expect.closeTo(1.304, 9) });
    expect(priced({ inputTokens: 300_000, speed: "fast" })).toMatchObject({ known: true, costUsd: expect.closeTo(2.608, 9) });
    expect(priced({ inputTokens: 272_000, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 }).costUsd).toBeCloseTo(0.544, 9);
    expect(priced({ inputTokens: 272_001, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 }).costUsd).toBeCloseTo(1.088004, 9);
    expect(priced({ model: `${model}-pro` }).known).toBe(false);
    // OpenRouter catalog rates are floors, not a promise of a routed bill.
    expect(priced({ provider: "openrouter", model: `openai/${model}` })).toMatchObject({ known: false, costEstimated: true });
  });
});
