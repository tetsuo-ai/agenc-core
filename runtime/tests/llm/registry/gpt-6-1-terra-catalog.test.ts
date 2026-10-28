import { describe, expect, test } from "vitest";
import { childModelProfile } from "../../../src/agents/provider-selector-profiles.js";
import { resolveRegisteredModelCatalogEntry, resolveModelCatalogMetadata } from "../../../src/llm/registry/model-catalog.js";
import { BUILT_IN_PROVIDER_DEFAULT_MODELS, BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../../src/llm/registry/provider-info.js";
import {
  openAiChatCompletionsRejectsFunctionTools,
  openAiModelDefaultsToNoReasoning,
  openAiModelScopesPromptCacheByKey,
} from "../../../src/llm/registry/openai-reasoning-models.js";
import { resolveReasoningEffort } from "../../../src/llm/reasoning-effort.js";
import { buildOpenAIResponsesRequest } from "../../../src/llm/wire/responses-openai.js";
import { buildChatCompletionsRequest } from "../../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import { resolveSessionReasoningEffort } from "../../../src/session/session-reasoning-effort.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS, type ModelUsage } from "../../../src/session/cost.js";

const model = "gpt-6.1-terra";
const efforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const priced = (extra: Partial<ModelUsage> = {}) => computeUsdCostWithResolution({
  provider: "openai", model, inputTokens: 100_000, outputTokens: 10_000,
  cachedInputTokens: 20_000, cacheCreationInputTokens: 30_000,
  reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: 110_000,
  turns: 1, singleCall: true, ...extra,
}, DEFAULT_MODEL_COSTS);

describe("GPT-6.1 Terra, official docs and live API reviewed 2026-10-28", () => {
  test("registers exact native and OpenRouter identities without changing defaults", () => {
    const native = resolveRegisteredModelCatalogEntry({ provider: "openai", model });
    expect(native).toMatchObject({ displayName: "GPT-6.1 Terra", contextWindow: 1_050_000,
      maxOutputTokens: 128_000, supportedReasoningLevels: efforts, defaultReasoningLevel: "medium",
      inputModalities: ["text", "image"], supportsToolUse: true, supportsStructuredOutput: true,
      additionalSpeedTiers: ["fast"], visibility: "list" });
    expect(resolveModelCatalogMetadata({ provider: "openai", model })).toMatchObject({
      contextWindow: 1_050_000, maxOutputTokens: 128_000, maxOutputTokensUpperLimit: 128_000,
    });
    expect(resolveRegisteredModelCatalogEntry({ provider: "openrouter", model: `openai/${model}` }))
      .toMatchObject({ contextWindow: 1_050_000, maxOutputTokens: 128_000, inputModalities: ["image", "text"],
        supportedReasoningLevels: [...efforts].reverse(), defaultReasoningLevel: "medium", supportsToolUse: true });
    // Pro mode is a separate OpenRouter id without none; OpenAI lists no Pro model.
    expect(resolveRegisteredModelCatalogEntry({ provider: "openrouter", model: `openai/${model}-pro` }))
      .toMatchObject({ contextWindow: 1_050_000, maxOutputTokens: 128_000,
        supportedReasoningLevels: ["max", "xhigh", "high", "medium", "low"], defaultReasoningLevel: "medium" });
    const openai = BUILT_IN_PROVIDER_MODEL_CATALOG.openai;
    expect(openai.filter(id => id === model)).toHaveLength(1);
    expect(openai.indexOf("gpt-6.1-sol")).toBeLessThan(openai.indexOf(model));
    expect(openai.indexOf(model)).toBeLessThan(openai.indexOf("gpt-6-sol"));
    const openrouter = BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter;
    expect(openrouter.filter(id => id === `openai/${model}`)).toHaveLength(1);
    // OpenRouter lists its newest models first; Terra is newer than every bundled row.
    expect(openrouter.indexOf(`openai/${model}-pro`)).toBeLessThan(openrouter.indexOf(`openai/${model}`));
    expect(openrouter.indexOf(`openai/${model}`)).toBeLessThan(openrouter.indexOf("openai/gpt-6.1-sol"));
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.openai).toBe("gpt-5");
    expect(openai[0]).toBe("gpt-5");
    expect(openrouter[0]).toBe("x-ai/grok-4.5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.github).not.toContain(`github:copilot:${model}`);
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: `${model}-pro` })).toBeUndefined();
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: `${model}-unverified` })).toBeUndefined();
    expect(resolveRegisteredModelCatalogEntry({ provider: "other", model })).toBeUndefined();
  });

  test.each(efforts)("preserves %s through native and OpenRouter request builders", effort => {
    const contract = resolveReasoningEffort({ provider: "openai", model });
    expect(contract).toMatchObject({ registered: true, levels: efforts, defaultLevel: "medium", acceptsChatEffort: true });
    // None is sent literally: an omitted effort runs the medium default.
    const wire = resolveSessionReasoningEffort(effort, efforts, { provider: "openai", model });
    expect(wire).toBe(effort);
    const body = buildOpenAIResponsesRequest({ model, messages: [], tools: [],
      options: { reasoningEffort: wire, temperature: 0.2, maxOutputTokens: 128, serviceTier: "priority" } });
    expect(body.reasoning?.effort).toBe(effort);
    // The live API takes temperature at none and rejects it at every other effort.
    if (effort === "none") expect(body.temperature).toBe(0.2);
    else expect(body).not.toHaveProperty("temperature");
    expect(body.max_output_tokens).toBe(128);
    expect(body.service_tier).toBe("priority");
    const routed = buildChatCompletionsRequest({ model: `openai/${model}`, messages: [], tools: [],
      options: { reasoningEffort: effort },
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("openrouter", `openai/${model}`) });
    expect(routed.reasoning).toEqual({ effort });
    expect(routed).not.toHaveProperty("reasoning_effort");
  });

  test("keeps the medium default, the user cache scope and the Sol/Luna Chat Completions tool rule", () => {
    expect(openAiModelDefaultsToNoReasoning(model)).toBe(false);
    const omitted = buildOpenAIResponsesRequest({ model, messages: [], tools: [], options: { temperature: 0.2 } });
    expect(omitted).not.toHaveProperty("temperature");
    expect(openAiModelScopesPromptCacheByKey(model)).toBe(true);
    expect(openAiModelScopesPromptCacheByKey(`openai/${model}`)).toBe(true);
    // Live 2026-10-28: 400 with the effort omitted or at medium, a tool call at none.
    expect(openAiChatCompletionsRejectsFunctionTools(model, undefined)).toBe(true);
    for (const effort of efforts.filter(level => level !== "none")) {
      expect(openAiChatCompletionsRejectsFunctionTools(model, effort)).toBe(true);
    }
    expect(openAiChatCompletionsRejectsFunctionTools(model, "none")).toBe(false);
    expect(resolveReasoningEffort({ provider: "openai", model }).levels).not.toContain("minimal");
  });

  test("routes sub-agents with the balanced prior of GPT-5.6 Terra", () => {
    expect(childModelProfile("openai", model)).toBeDefined();
    expect(childModelProfile("openai", model)).toBe(childModelProfile("openai", "gpt-5.6-terra"));
    expect(childModelProfile("openai", `${model}-pro`)).toBeUndefined();
  });

  test("prices cache reads at 5%, cache writes at 1.25x, long context and Fast", () => {
    // 50K uncached + 20K cached + 30K written + 10K output:
    // $0.05 + $0.001 + $0.0375 + $0.05.
    expect(priced()).toMatchObject({ known: true, costUsd: expect.closeTo(0.1385, 9) });
    expect(priced({ speed: "fast" })).toMatchObject({ known: true, costUsd: expect.closeTo(0.277, 9) });
    // Over 272K input the whole request moves to $2 / $0.10 / $2.50 / $7.50.
    expect(priced({ inputTokens: 300_000 })).toMatchObject({ known: true, costUsd: expect.closeTo(0.652, 9) });
    expect(priced({ inputTokens: 300_000, speed: "fast" })).toMatchObject({ known: true, costUsd: expect.closeTo(1.304, 9) });
    expect(priced({ inputTokens: 272_000, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 }).costUsd).toBeCloseTo(0.272, 9);
    expect(priced({ inputTokens: 272_001, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 }).costUsd).toBeCloseTo(0.544002, 9);
    // Reasoning tokens are part of output_tokens and bill at the output rate.
    expect(priced({ reasoningOutputTokens: 4_000 }).costUsd).toBeCloseTo(0.1385, 9);
    expect(priced({ model: `${model}-pro` }).known).toBe(false);
    // OpenRouter catalog rates are floors, not a promise of a routed bill.
    for (const routed of [`openai/${model}`, `openai/${model}-pro`]) {
      expect(priced({ provider: "openrouter", model: routed })).toMatchObject({ known: false, costEstimated: true });
    }
  });
});
