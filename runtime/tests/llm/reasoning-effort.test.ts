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
      expect(resolved.defaultLevel).toBe(row.defaultLevel);
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
  "seeds and serializes NIM $model including its default", row => {
    const seed = (reasoning_effort?: string) => sessionConfigurationFromAgenCConfig({
      config: { ...(reasoning_effort !== undefined ? { reasoning_effort: reasoning_effort as AgenCConfig["reasoning_effort"] } : {}) }, workspaceRoot: process.cwd(), provider: row.provider, model: row.model,
    }).collaborationMode.reasoningEffort;
    expect(seed()).toBe(row.defaultLevel);
    const hints = chatCompletionsCapabilityHintsForProvider(row.provider, row.model);
    for (const level of row.levels) {
      expect(seed(level)).toBe(level);
      expect(buildChatCompletionsRequest({ model: row.model, messages: [], tools: [],
        options: { reasoningEffort: level as NonNullable<LLMChatOptions["reasoningEffort"]> }, providerCapabilityHints: hints }).reasoning_effort).toBe(level);
    }
    expect(buildChatCompletionsRequest({ model: row.model, messages: [], tools: [],
      options: { reasoningEffort: "xhigh" }, providerCapabilityHints: hints }).reasoning_effort).toBeUndefined();
  });
