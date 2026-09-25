import { describe, expect, test } from "vitest";
import { OPENAI_REASONING_MODELS } from "../../src/llm/registry/openai-reasoning-models.js";
import {
  resolveModelCatalogMetadata,
  resolveRegisteredModelCatalogEntry,
} from "../../src/llm/registry/model-catalog.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../src/llm/registry/provider-info.js";
import { resolveReasoningEffort } from "../../src/llm/reasoning-effort.js";
import { resolveProviderModelCapabilities } from "../../src/llm/capabilities.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import { buildOpenAIResponsesRequest } from "../../src/llm/wire/responses-openai.js";
import { resolveSessionReasoningEffort } from "../../src/phases/stream-model.js";
import { sessionConfigurationFromAgenCConfig } from "../../src/session/configuration.js";
import { defaultConfig } from "../../src/config/schema.js";
import { effortValueToReasoningEffort, getAvailableEffortLevelsForContext } from "../../src/utils/effort.js";

describe("OpenAI OAuth reasoning model contract", () => {
  test.each(OPENAI_REASONING_MODELS)("$model preserves every positive tier from configuration to Responses", ({ model, efforts }) => {
    const entry = resolveRegisteredModelCatalogEntry({ provider: "openai", model })!;
    expect(entry.supportedReasoningLevels).toEqual(efforts);
    expect(resolveProviderModelCapabilities({ provider: "openai", model }).acceptsReasoningEffort).toBe(true);
    expect(chatCompletionsCapabilityHintsForProvider("openai", model).acceptsReasoningEffort).toBe(true);
    // The TUI dial has no None rung for any provider; it lists the rest.
    expect(getAvailableEffortLevelsForContext(model, { provider: "openai", environment: {}, home: {} } as never))
      .toEqual(efforts.filter((effort) => effort !== "none"));
    for (const effort of efforts) {
      const configuration = sessionConfigurationFromAgenCConfig({
        config: { ...defaultConfig(), model_provider: "openai", reasoning_effort: effort },
        provider: "openai", workspaceRoot: "/tmp/openai-effort-fixture", model,
      });
      expect(configuration.collaborationMode.reasoningEffort).toBe(effort);
      // A TUI helper, which like the TUI dial has no None rung.
      if (effort !== "none") expect(effortValueToReasoningEffort(effort, efforts)).toBe(effort);
      const resolved = resolveSessionReasoningEffort(configuration.collaborationMode.reasoningEffort, entry.supportedReasoningLevels, { provider: "openai", model });
      const request = buildOpenAIResponsesRequest({ model, messages: [{ role: "user", content: "Fixture only" }], tools: [], options: { reasoningEffort: resolved } });
      expect(request.reasoning?.effort).toBe(effort);
    }
  });

  test("does not grant an unverified variant max effort or leak OpenAI capabilities to another provider", () => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: "gpt-6-astra-unverified" })).toBeUndefined();
    expect(resolveRegisteredModelCatalogEntry({ provider: "other", model: "gpt-6-astra" })).toBeUndefined();
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: "gpt-5.4" })?.supportedReasoningLevels).not.toContain("max");
  });
});

// developers.openai.com/api/docs/models/gpt-6-sol and /gpt-6-luna, read
// 2026-09-22: 1,050,000-token window, 128,000 max output, text and image in,
// reasoning.effort none..max with medium as the API default, and a Fast mode
// price on the pricing page.
const GPT_6_SOL_AND_LUNA = [
  { model: "gpt-6-sol", label: "GPT-6 Sol" },
  { model: "gpt-6-luna", label: "GPT-6 Luna" },
] as const;
const SOL_AND_LUNA_TIERS = ["none", "low", "medium", "high", "xhigh", "max"];

describe("GPT-6 Sol and GPT-6 Luna", () => {
  test.each(GPT_6_SOL_AND_LUNA)("registers $model with its documented window, output cap and tiers", ({ model, label }) => {
    expect(OPENAI_REASONING_MODELS.find((entry) => entry.model === model)).toMatchObject({
      label,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      vision: true,
      chatgpt: true,
    });
    const entry = resolveRegisteredModelCatalogEntry({ provider: "openai", model });
    expect(entry).toMatchObject({
      displayName: label,
      contextWindow: 1_050_000,
      maxContextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      inputModalities: ["text", "image"],
      supportsToolUse: true,
      supportsStructuredOutput: true,
      additionalSpeedTiers: ["fast"],
      visibility: "list",
    });
    // `none` is a real rung: the session pipeline sends it on the wire for
    // these models. An unset effort is left to the documented medium default.
    expect(entry?.supportedReasoningLevels).toEqual(SOL_AND_LUNA_TIERS);
    expect(entry?.defaultReasoningLevel).toBeUndefined();
    expect(resolveModelCatalogMetadata({ provider: "openai", model })).toEqual({
      contextWindow: 1_050_000,
      maxContextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      maxOutputTokensUpperLimit: 128_000,
    });
    expect(resolveReasoningEffort({ provider: "openai", model })).toMatchObject({
      registered: true,
      acceptsChatEffort: true,
      levels: SOL_AND_LUNA_TIERS,
    });
  });

  test.each(GPT_6_SOL_AND_LUNA)("sends each offered tier and the Fast service tier to Responses for $model", ({ model }) => {
    const levels = resolveRegisteredModelCatalogEntry({ provider: "openai", model })?.supportedReasoningLevels ?? [];
    expect(levels).toEqual(SOL_AND_LUNA_TIERS);
    for (const effort of levels) {
      const wire = resolveSessionReasoningEffort(effort, levels, { provider: "openai", model });
      const request = buildOpenAIResponsesRequest({
        model,
        messages: [{ role: "user", content: "Fixture only" }],
        tools: [],
        options: { reasoningEffort: wire, serviceTier: "priority" },
      });
      expect(request.reasoning?.effort).toBe(effort);
      expect(request.service_tier).toBe("priority");
    }
  });

  test.each(GPT_6_SOL_AND_LUNA)("keeps an explicit none on the wire for $model instead of the medium default", ({ model }) => {
    const levels = resolveRegisteredModelCatalogEntry({ provider: "openai", model })?.supportedReasoningLevels ?? [];
    const wire = resolveSessionReasoningEffort("none", levels, { provider: "openai", model });
    expect(wire).toBe("none");
    const request = buildOpenAIResponsesRequest({
      model,
      messages: [{ role: "user", content: "Fixture only" }],
      tools: [],
      options: { reasoningEffort: wire, temperature: 0.2 },
    });
    expect(request.reasoning?.effort).toBe("none");
    // Sampling parameters are accepted only at effort none.
    expect(request.temperature).toBe(0.2);
  });

  test("still omits none for OpenAI models that do not take it and for other providers", () => {
    const astra = resolveRegisteredModelCatalogEntry({ provider: "openai", model: "gpt-6-astra" })?.supportedReasoningLevels ?? [];
    expect(astra).not.toContain("none");
    expect(resolveSessionReasoningEffort("none", astra, { provider: "openai", model: "gpt-6-astra" })).toBeUndefined();
    expect(resolveSessionReasoningEffort("none", ["low", "medium", "high"], { provider: "grok", model: "grok-4.5" })).toBeUndefined();
  });

  test("appends the rows after Astra so GPT-5.6 Sol still leads and gpt-5 stays the provider default", () => {
    expect(OPENAI_REASONING_MODELS.map((entry) => entry.model)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.openai).toBe("gpt-5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openai[0]).toBe("gpt-5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openai).toEqual(expect.arrayContaining(["gpt-6-sol", "gpt-6-luna"]));
  });

  test.each(GPT_6_SOL_AND_LUNA)("keeps unverified $model variants and other providers without its tiers", ({ model }) => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model })?.model).toBe(model);
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: `${model}-unverified` })).toBeUndefined();
    expect(resolveReasoningEffort({ provider: "openai", model: `${model}-unverified` }).levels).toEqual([]);
    expect(resolveRegisteredModelCatalogEntry({ provider: "other", model })).toBeUndefined();
  });
});
