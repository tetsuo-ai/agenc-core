import { describe, expect, it } from "vitest";

import {
  resolveImageInputSupport,
  resolveProviderModelCapabilities,
} from "../../src/llm/capabilities.js";
import { REGISTERED_MODEL_CATALOG } from "../../src/llm/registry/model-catalog.js";

describe("resolveImageInputSupport", () => {
  it("follows every catalog row: text-only rows are unsupported, image rows supported", () => {
    for (const entry of REGISTERED_MODEL_CATALOG) {
      const expected = entry.inputModalities.includes("image")
        ? "supported"
        : "unsupported";
      expect(
        resolveImageInputSupport({ provider: entry.provider, model: entry.model }),
        `${entry.provider}/${entry.model}`,
      ).toBe(expected);
    }
  });

  it.each([
    // Documented text-only models: the query projection removes their images.
    ["deepseek", "deepseek-v4-pro", "unsupported"],
    ["agenc", "deepseek/deepseek-v4-flash-0731", "unsupported"],
    ["cerebras", "gpt-oss-120b", "unsupported"],
    ["qwen", "qwen3.7-max", "unsupported"],
    ["zai", "glm-5.3", "unsupported"],
    ["minimax", "MiniMax-M2.7", "unsupported"],
    ["ollama-cloud", "glm-5.3", "unsupported"],
    ["meta", "llama-unlisted", "unsupported"],
    ["kimi", "kimi-unlisted", "unsupported"],
    ["grok", "grok-imagine-image", "unsupported"],
    // The Bedrock adapter serializes text only, whatever the model.
    ["amazon-bedrock", "anthropic.claude-sonnet-4", "unsupported"],
    // Vision models keep their images.
    ["deepseek", "deepseek-flash", "supported"],
    ["agenc", "deepseek/deepseek-v4.1-flash", "supported"],
    ["anthropic", "claude-sonnet-5", "supported"],
    ["openai", "gpt-5.6-sol", "supported"],
    ["grok", "grok-4.6", "supported"],
    ["gemini", "gemini-3.1-pro-preview", "supported"],
    ["qwen", "qwen3.8-max", "supported"],
    // A constant `false` on a host of many models is a fail-closed default,
    // not knowledge of the model: the wire keeps its own policy.
    ["openrouter", "anthropic/claude-sonnet-5", "unknown"],
    ["agenc", "agenc", "unknown"],
    ["openai-compatible", "llava:13b", "unknown"],
    ["groq", "meta-llama/llama-4-scout-17b-16e-instruct", "unknown"],
    ["mistral", "pixtral-large-latest", "unknown"],
    ["nvidia-nim", "meta/llama-3.2-90b-vision-instruct", "unknown"],
    ["github", "gpt-4.1", "unknown"],
    ["deepseek", "deepseek-chat", "unknown"],
    // Local servers are probed by their own adapters.
    ["ollama", "qwen2.5-coder:7b", "unknown"],
    ["lmstudio", "qwen2.5-coder-7b", "unknown"],
    // An unregistered provider is unknown, never text-only.
    ["stub-provider", "test-model", "unknown"],
  ] as const)("%s/%s is %s", (provider, model, expected) => {
    expect(resolveImageInputSupport({ provider, model })).toBe(expected);
  });

  it("is never more permissive than the capability registry", () => {
    for (const entry of REGISTERED_MODEL_CATALOG) {
      const support = resolveImageInputSupport({
        provider: entry.provider,
        model: entry.model,
      });
      const caps = resolveProviderModelCapabilities({
        provider: entry.provider,
        model: entry.model,
      });
      if (support === "supported") expect(caps.supportsImageInput).toBe(true);
    }
  });

  it("lets a configured override decide", () => {
    expect(
      resolveImageInputSupport({
        provider: "openai-compatible",
        model: "my-vision-model",
        overrides: { supportsImageInput: true },
      }),
    ).toBe("supported");
    expect(
      resolveImageInputSupport({
        provider: "deepseek",
        model: "deepseek-flash",
        overrides: { supportsImageInput: false },
      }),
    ).toBe("unsupported");
  });

  it("treats retired or empty selectors as unknown instead of throwing", () => {
    expect(resolveImageInputSupport({ provider: "xai", model: "grok-4" })).toBe("unknown");
    expect(resolveImageInputSupport({ provider: undefined, model: "x" })).toBe("unknown");
    expect(resolveImageInputSupport({ provider: "deepseek", model: " " })).toBe("unknown");
  });
});
