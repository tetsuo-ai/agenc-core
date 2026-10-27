/**
 * Session shape that follows the model through a gateway: DeepSeek's 64k
 * per-call output default (with the route's limit as the ceiling) and GPT's
 * parallel tool calls and personality instructions.
 */
import { describe, expect, test } from "vitest";

import { defaultConfig } from "../../src/config/schema.js";
import { ModelMetadataResolver } from "../../src/llm/model-metadata.js";
import { ModelRegistry, modelRegistryEntryToModelInfo } from "../../src/llm/model-registry.js";
import type { AgenCConfig } from "../../src/utils/config.js";

const EMPTY_CONFIG = {} as unknown as AgenCConfig;

describe("DeepSeek per-call output default through gateways", () => {
  test("DeepSeek's own API reserves 64k a call with a 393,216 ceiling", () => {
    expect(new ModelMetadataResolver({ env: {} }).resolveSync({ provider: "deepseek", model: "deepseek-flash", config: EMPTY_CONFIG }))
      .toMatchObject({ maxOutputTokens: 64_000, maxOutputTokensUpperLimit: 393_216, maxOutputTokensCappedDefault: true });
  });

  test.each([
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017", 393_216],
    // OpenRouter lists max_completion_tokens 393,216 for this route (live list, 2026-10-21).
    ["openrouter", "deepseek/deepseek-v4-pro-0813", 393_216],
    ["ollama-cloud", "deepseek-v4-pro:0813", 393_216],
    ["ollama-cloud", "deepseek-v4.1-flash", 393_216],
    ["abliteration", "abliterated-model-large-flash", 262_144],
  ] as const)("%s %s reserves 64k a call; the route limit stays the ceiling", (provider, model, ceiling) => {
    const resolved = new ModelMetadataResolver({ env: {} }).resolveSync({ provider, model, config: EMPTY_CONFIG });
    expect(resolved).toMatchObject({ maxOutputTokens: 64_000, maxOutputTokensUpperLimit: ceiling, maxOutputTokensCappedDefault: true });
  });

  test("an explicit output setting still wins", () => {
    const resolved = new ModelMetadataResolver({ env: { AGENC_MAX_OUTPUT_TOKENS: "8192" } }).resolveSync({
      provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017", config: EMPTY_CONFIG,
    });
    expect(resolved.maxOutputTokens).toBe(8192);
    expect(resolved.maxOutputTokensCappedDefault).toBe(false);
  });

  test("other OpenRouter families use the bounded gateway default", () => {
    const glm = new ModelMetadataResolver({ env: {} }).resolveSync({ provider: "ollama-cloud", model: "glm-5.3", config: EMPTY_CONFIG });
    expect(glm.maxOutputTokens).toBe(16_384);
    const luna = new ModelMetadataResolver({ env: {} }).resolveSync({ provider: "openrouter", model: "openai/gpt-6-luna", config: EMPTY_CONFIG });
    expect(luna.maxOutputTokens).toBe(32_000);
    expect(luna.maxOutputTokensUpperLimit).toBe(128_000);
  });
});

describe("DeepSeek default effort shown for gateways", () => {
  test.each([
    ["ollama-cloud", "deepseek-v4-pro:0813"],
    ["ollama-cloud", "deepseek-v4.1-flash"],
    ["openrouter", "deepseek/deepseek-v4-pro-0813"],
    ["abliteration", "abliterated-model-large-flash"],
  ])("%s %s defaults to high like DeepSeek's own API", (provider, model) => {
    const registry = new ModelRegistry({ config: defaultConfig() });
    expect(modelRegistryEntryToModelInfo(registry.resolveSync({ provider, model })).defaultReasoningLevel).toBe("high");
    expect(modelRegistryEntryToModelInfo(registry.resolveSync({ provider: "deepseek", model: "deepseek-flash" })).defaultReasoningLevel).toBe("high");
  });
});

describe("GPT session shape through gateways", () => {
  test("OpenRouter GPT sends parallel tool calls and carries the personality instructions, as OpenAI's own API does", () => {
    const registry = new ModelRegistry({ config: defaultConfig() });
    const info = modelRegistryEntryToModelInfo(registry.resolveSync({ provider: "openrouter", model: "openai/gpt-6-luna" }));
    const direct = modelRegistryEntryToModelInfo(registry.resolveSync({ provider: "openai", model: "gpt-6-luna" }));
    expect(info.supportsParallelToolCalls).toBe(true);
    expect(info.supportsPersonality).toBe(true);
    expect(info.modelMessages).toEqual(direct.modelMessages);
  });

  test("other OpenRouter models keep the catalog's flags", () => {
    const registry = new ModelRegistry({ config: defaultConfig() });
    const info = modelRegistryEntryToModelInfo(registry.resolveSync({ provider: "openrouter", model: "z-ai/glm-5.3" }));
    expect(info.supportsPersonality).toBe(false);
    expect(info.modelMessages).toBeUndefined();
  });
});
