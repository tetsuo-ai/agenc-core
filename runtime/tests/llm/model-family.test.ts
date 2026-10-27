import { describe, expect, test } from "vitest";

import { gatewayModelFamily, modelFamilyFor } from "../../src/llm/model-family.js";

describe("model family behind a provider/model pair", () => {
  test.each([
    // DeepSeek V4.1 Flash 1017 and V4 Pro 0813 under each gateway's id.
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017", "deepseek"],
    ["openrouter", "deepseek/deepseek-v4-pro-0813", "deepseek"],
    ["openrouter", "deepseek/deepseek-v4.1-flash:nitro", "deepseek"],
    ["ollama-cloud", "deepseek-v4.1-flash:1017", "deepseek"],
    ["ollama-cloud", "deepseek-v4-pro:0813", "deepseek"],
    ["venice", "deepseek-v4-1-flash-1017", "deepseek"],
    ["venice", "deepseek-v4-pro-0813", "deepseek"],
    ["abliteration", "abliterated-model-large-flash", "deepseek"],
    ["abliteration", " ABLITERATED-MODEL-LARGE-FLASH ", "deepseek"],
    ["openrouter", "moonshotai/kimi-k3", "kimi"],
    ["openrouter", "moonshotai/kimi-k3:batch", "kimi"],
    ["openrouter", "moonshotai/kimi-k2.7-code:nitro", "kimi"],
    ["openrouter", "~moonshotai/kimi-latest", "kimi"],
    ["ollama-cloud", "kimi-k3", "kimi"],
    // GPT-6 Luna and other hosted GPT reasoning models.
    ["openrouter", "openai/gpt-6-luna", "openai"],
    ["openrouter", "~openai/gpt-luna-latest", undefined],
    ["openrouter", "openai/gpt-5.6-luna", "openai"],
    ["openrouter", "openai/o4-mini", "openai"],
    ["venice", "openai-gpt-6-luna", "openai"],
    ["venice", "openai-gpt-61-sol", "openai"],
    ["venice", "openai-gpt-56-luna", "openai"],
  ] as const)("%s %s -> %s", (provider, model, family) => {
    expect(gatewayModelFamily(provider, model)).toBe(family);
    expect(modelFamilyFor(provider, model)).toBe(family);
  });

  test.each([
    ["openrouter", "openai/gpt-oss-120b"],
    ["openrouter", "openai/gpt-4o"],
    ["openrouter", "x-ai/grok-4.7"],
    ["openrouter", "deepseek-v4.1-flash"],
    ["ollama-cloud", "gpt-oss:120b"],
    ["openrouter", "other/kimi-k3"],
    ["venice", "openai-gpt-oss-120b"],
    ["venice", "openai-gpt-4o-2024-11-20"],
    ["venice", "zai-org-glm-5-2"],
    ["abliteration", "abliterated-model"],
    ["abliteration", "abliterated-model-large"],
    ["abliteration", "abliterated-model-large-v2"],
    ["abliteration", "abliterated-model-large-flash-next"],
    ["abliteration", "abliterated-model-large-flash:free"],
    ["abliteration", "deepseek-v4.1-flash"],
    ["openai-compatible", "abliterated-model-large-flash"],
    // Not gateways: the managed route and custom endpoints keep their own contracts.
    ["agenc", "deepseek/deepseek-v4.1-flash"],
    ["openai-compatible", "deepseek-v4-flash"],
    ["groq", "openai/gpt-oss-120b"],
  ] as const)("%s %s has no family", (provider, model) => {
    expect(gatewayModelFamily(provider, model)).toBeUndefined();
    expect(modelFamilyFor(provider, model)).toBeUndefined();
  });

  test("native providers are their own family whatever the model id", () => {
    expect(modelFamilyFor("deepseek", "deepseek-flash")).toBe("deepseek");
    expect(modelFamilyFor("deepseek", undefined)).toBe("deepseek");
    expect(modelFamilyFor("kimi", "kimi-k3.1-pro")).toBe("kimi");
    expect(modelFamilyFor("openai", "gpt-6-luna")).toBe("openai");
    expect(modelFamilyFor("OpenAI", undefined)).toBe("openai");
    expect(gatewayModelFamily("deepseek", "deepseek-flash")).toBeUndefined();
    expect(modelFamilyFor(undefined, "deepseek/deepseek-v4.1-flash-1017")).toBeUndefined();
  });
});
