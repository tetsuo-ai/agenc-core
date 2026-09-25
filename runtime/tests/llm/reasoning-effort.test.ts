import { buildAnthropicMessagesRequest } from "../../src/llm/wire/messages-anthropic.js";
import { resolveSessionReasoningEffort } from "../../src/phases/stream-model.js";
import type { ReasoningEffort } from "../../src/session/turn-context.js";
import type { AgenCConfig } from "../../src/config/schema.js";
import type { LLMChatOptions } from "../../src/llm/types.js";
import { describe, expect, it } from "vitest";
import { resolveReasoningEffort } from "../../src/llm/reasoning-effort.js";
import { listRegisteredModelCatalogEntries } from "../../src/llm/registry/model-catalog.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import catalog from "./desktop-effort-catalog.json";

import { sessionConfigurationFromAgenCConfig } from "../../src/session/configuration.js";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { mergeProviderModelLayer } from "../../src/config/provider-model-authority.js";
import { defaultConfig } from "../../src/config/schema.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";

describe("provider-scoped effort contract", () => {
  it.each(listRegisteredModelCatalogEntries())("preserves $provider/$model", entry => {
    expect(resolveReasoningEffort(entry)).toMatchObject({ levels: entry.supportedReasoningLevels,
      ...(entry.defaultReasoningLevel === undefined ? {} : { defaultLevel: entry.defaultReasoningLevel }) });
  });
  it.each(catalog.filter(row => row.levels.length > 0))("supports Desktop $provider/$model", row => {
    const resolved = resolveReasoningEffort(row);
    for (const level of row.levels) expect(resolved.levels).toContain(level);
    if (row.defaultLevel !== undefined) expect(resolved.levels).toContain(row.defaultLevel);
    expect(resolved.levels).not.toContain("invalid");
    if (row.provider === "nvidia-nim") {
      const wire = chatCompletionsCapabilityHintsForProvider(row.provider, row.model);
      expect(wire.reasoningEffortAllowedValues).toEqual(new Set(resolved.levels));
      expect(resolved.defaultLevel).toBeUndefined();
    }
  });
  it("does not borrow hosted capabilities across providers", () => {
    expect(resolveReasoningEffort({provider: "openrouter", model: "openai/gpt-oss-120b"}).levels).toEqual([]);
    expect(resolveReasoningEffort({provider: "nvidia-nim", model: "unknown"}).levels).toEqual([]);
  });
});


it.each(catalog)("can select Desktop $provider/$model", row => {
  expect(mergeProviderModelLayer({}, { model_provider: row.provider, model: row.model }))
    .toMatchObject({ model_provider: row.provider, model: row.model });
});

it.each(catalog.filter(row => row.provider === "nvidia-nim" && row.levels.length > 0))(
  "seeds and serializes NIM $model without inventing a default", row => {
    const seed = (reasoning_effort?: string) => sessionConfigurationFromAgenCConfig({
      config: { ...(reasoning_effort !== undefined ? { reasoning_effort: reasoning_effort as AgenCConfig["reasoning_effort"] } : {}) }, workspaceRoot: process.cwd(), provider: row.provider, model: row.model,
    }).collaborationMode.reasoningEffort;
    expect(seed()).toBeUndefined();
    expect(buildChatCompletionsRequest({ model: row.model, messages: [], tools: [],
      options: {}, providerCapabilityHints: chatCompletionsCapabilityHintsForProvider(row.provider, row.model) }).reasoning_effort).toBeUndefined();
    const hints = chatCompletionsCapabilityHintsForProvider(row.provider, row.model);
    for (const level of row.levels) {
      expect(seed(level)).toBe(level);
      expect(buildChatCompletionsRequest({ model: row.model, messages: [], tools: [],
        options: { reasoningEffort: level as NonNullable<LLMChatOptions["reasoningEffort"]> }, providerCapabilityHints: hints }).reasoning_effort).toBe(level);
    }
    expect(buildChatCompletionsRequest({ model: row.model, messages: [], tools: [],
      options: { reasoningEffort: "xhigh" }, providerCapabilityHints: hints }).reasoning_effort).toBeUndefined();
  });


it.each([
  ["claude-opus-4-6", "xhigh"],
  ["claude-sonnet-4-6", "xhigh"],
  ["claude-opus-4-5", "max"],
  ["claude-opus-4-5", "xhigh"],
] as const)("clamps unsupported %s/%s before building the Anthropic body", (model, requested) => {
  const row = { provider: "anthropic", model };
  expect(resolveReasoningEffort(row).levels).not.toContain(requested);
  const seed = sessionConfigurationFromAgenCConfig({ config: { reasoning_effort: requested },
    workspaceRoot: process.cwd(), ...row }).collaborationMode.reasoningEffort;
  const normalized = resolveSessionReasoningEffort(seed, [], row);
  expect(normalized).toBe("high");
  for (const effort of [requested, normalized]) {
    const body = buildAnthropicMessagesRequest({ model, messages: [], tools: [],
      maxTokens: 4096, options: { reasoningEffort: effort } });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.thinking).toEqual(model === "claude-opus-4-5"
      ? { type: "enabled", budget_tokens: 4095 } : { type: "adaptive" });
  }
});

it.each(catalog.filter(row => row.provider === "anthropic"))(
  "serializes all five Desktop Claude tiers for $model", row => {
    expect(resolveReasoningEffort(row).levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const effort of row.levels) {
      const normalized = resolveSessionReasoningEffort(effort as ReasoningEffort, [], row);
      const body = buildAnthropicMessagesRequest({ model: row.model, messages: [], tools: [],
        maxTokens: 4096, options: { reasoningEffort: normalized } });
      expect(body.output_config).toEqual({ effort });
    }
  });


// Opus 5.5 is not in the Desktop fixture yet. Before it had its own effort
// row, the empty contract seeded a configured max as xhigh, clamped it to
// high, and the wire then dropped output_config.effort altogether. The turn
// passes the session model's registry levels, as stream-model does.
it("carries every Claude Opus 5.5 tier from config seed to the wire", async () => {
  const row = { provider: "anthropic", model: "claude-opus-5-5" };
  const levels = ["low", "medium", "high", "xhigh", "max"] as const;
  expect(resolveReasoningEffort(row).levels).toEqual(levels);
  const modelInfo = await new StaticModelsManager({
    config: defaultConfig(),
    fallbackProvider: "anthropic",
  }).getModelInfo(row.model);
  for (const effort of levels) {
    const seed = sessionConfigurationFromAgenCConfig({ config: { reasoning_effort: effort },
      workspaceRoot: process.cwd(), ...row }).collaborationMode.reasoningEffort;
    expect(seed).toBe(effort);
    const normalized = resolveSessionReasoningEffort(seed, modelInfo.supportedReasoningLevels, row);
    expect(normalized).toBe(effort);
    const body = buildAnthropicMessagesRequest({ model: row.model, messages: [], tools: [],
      maxTokens: 4096, options: { reasoningEffort: normalized } });
    expect(body.output_config).toEqual({ effort });
    expect(body.thinking).toBeUndefined();
  }
});

it("offers Bedrock effort levels exactly where the Converse adapter sends effort", () => {
  const opus55 = { provider: "amazon-bedrock", model: "anthropic.claude-opus-5-5" };
  expect(resolveReasoningEffort(opus55).levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  // Opus 5 and non-Claude models get no effort field on Converse, so no levels.
  expect(resolveReasoningEffort({ provider: "amazon-bedrock", model: "anthropic.claude-opus-5" }).levels)
    .toEqual([]);
  expect(resolveReasoningEffort({ provider: "amazon-bedrock", model: "amazon.nova-pro-v1:0" }).levels)
    .toEqual([]);
});

it("reads Bedrock effort from the registered contract that session and spawn validation use", async () => {
  const modelInfo = await new StaticModelsManager({
    config: defaultConfig(),
    fallbackProvider: "amazon-bedrock",
  }).getModelInfo("global.anthropic.claude-opus-5-5");
  const row = { provider: "amazon-bedrock", model: "global.anthropic.claude-opus-5-5" };
  expect(resolveReasoningEffort(row)).toMatchObject({
    registered: true,
    levels: modelInfo.supportedReasoningLevels,
    defaultLevel: modelInfo.defaultReasoningLevel,
  });
  // A configured max reaches the adapter unclamped, as stream-model passes it.
  expect(resolveSessionReasoningEffort("max", modelInfo.supportedReasoningLevels, row)).toBe("max");
  // A Claude model without a registered Bedrock contract gets no levels, so
  // the adapter sends it no effort field either.
  expect(resolveReasoningEffort({ provider: "amazon-bedrock", model: "global.anthropic.claude-fable-5-1" }))
    .toMatchObject({ registered: false, levels: [] });
});

it("seeds and sends a configured max for a Bedrock profile an override maps to Opus 5.5", async () => {
  const profile =
    "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6";
  const config = {
    ...defaultConfig(),
    reasoning_effort: "max" as const,
    modelOverrides: { "claude-opus-5-5": profile },
  };
  const seed = sessionConfigurationFromAgenCConfig({
    config, workspaceRoot: process.cwd(), provider: "amazon-bedrock", model: profile,
  }).collaborationMode.reasoningEffort;
  expect(seed).toBe("max");
  const modelInfo = await new StaticModelsManager({
    config,
    fallbackProvider: "amazon-bedrock",
  }).getModelInfo(profile);
  expect(resolveSessionReasoningEffort(seed, modelInfo.supportedReasoningLevels, {
    provider: "amazon-bedrock",
    model: profile,
  })).toBe("max");
});

it.each([
  { provider: "openai", model: "gpt-5.6-sol-unverified" },
  { provider: "grok", model: "grok-4-20-multi-agent-unverified" },
])("keeps transport compatibility separate from session validation for $provider/$model", row => {
  expect(resolveReasoningEffort(row)).toMatchObject({
    registered: false, acceptsChatEffort: true, levels: [],
  });
});

it.each(["claude-opus-4-6", "claude-sonnet-4-6"])("retains the verified four-tier contract for %s", model => {
  expect(resolveReasoningEffort({ provider: "anthropic", model }).levels).toEqual(["low", "medium", "high", "max"]);
  expect(buildAnthropicMessagesRequest({ model, messages: [], tools: [],
    options: { reasoningEffort: "max" } }).output_config).toEqual({ effort: "max" });
});
