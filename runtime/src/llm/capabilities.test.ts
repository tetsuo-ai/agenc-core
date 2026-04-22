import { describe, expect, it } from "vitest";
import {
  normalizeProviderSlug,
  resolveProviderModelCapabilities,
} from "./capabilities.js";

describe("normalizeProviderSlug", () => {
  it("normalizes xai to grok", () => {
    expect(normalizeProviderSlug("xai")).toBe("grok");
    expect(normalizeProviderSlug(" XAI ")).toBe("grok");
  });
});

describe("resolveProviderModelCapabilities", () => {
  it("uses documented xAI model metadata while keeping reasoning effort disabled", () => {
    const caps = resolveProviderModelCapabilities({
      provider: "xai",
      model: "grok-4.20-multi-agent-latest",
    });

    expect(caps).toMatchObject({
      provider: "grok",
      model: "grok-4.20-multi-agent-latest",
      supportsPromptCaching: true,
      supportsContextEdits: false,
      supportsImageInput: true,
      supportsAudioInput: false,
      supportsAudioOutput: false,
      supportsExtendedThinking: false,
      acceptsImageHistory: true,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: false,
    });
  });

  it("treats xAI imagine models as incompatible with image-bearing history", () => {
    const caps = resolveProviderModelCapabilities({
      provider: "grok",
      model: "grok-imagine-image-pro",
    });

    expect(caps.acceptsImageHistory).toBe(false);
    expect(caps.acceptsReasoningEffort).toBe(false);
  });

  it("tracks the documented OpenAI multimodal and reasoning support by model family", () => {
    expect(
      resolveProviderModelCapabilities({
        provider: "openai",
        model: "gpt-5",
      }),
    ).toMatchObject({
      provider: "openai",
      supportsPromptCaching: true,
      supportsContextEdits: false,
      supportsImageInput: true,
      supportsAudioInput: false,
      supportsAudioOutput: false,
      supportsExtendedThinking: true,
      acceptsImageHistory: true,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: true,
      acceptsReasoningEffort: true,
    });

    expect(
      resolveProviderModelCapabilities({
        provider: "openai",
        model: "gpt-4.1",
      }),
    ).toMatchObject({
      provider: "openai",
      supportsPromptCaching: true,
      supportsImageInput: true,
      supportsAudioInput: false,
      supportsAudioOutput: false,
      supportsExtendedThinking: false,
      acceptsImageHistory: true,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: false,
    });
  });

  it("distinguishes provider-level OpenAI audio support from history replay support", () => {
    expect(
      resolveProviderModelCapabilities({
        provider: "openai",
        model: "gpt-audio",
      }),
    ).toMatchObject({
      provider: "openai",
      supportsAudioInput: true,
      supportsAudioOutput: true,
      acceptsAudioHistory: false,
    });
  });

  it("keeps routed OpenAI-compatible providers fail-closed where the matrix says varies", () => {
    expect(
      resolveProviderModelCapabilities({
        provider: "openrouter",
        model: "openai/gpt-4.1",
      }),
    ).toMatchObject({
      provider: "openrouter",
      acceptsImageHistory: false,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: false,
    });

    expect(
      resolveProviderModelCapabilities({
        provider: "groq",
        model: "llama-3.3-70b-versatile",
      }),
    ).toMatchObject({
      provider: "groq",
      acceptsImageHistory: false,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: false,
    });

    expect(
      resolveProviderModelCapabilities({
        provider: "deepseek",
        model: "deepseek-chat",
      }),
    ).toMatchObject({
      provider: "deepseek",
      acceptsImageHistory: false,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: false,
    });
  });

  it("keeps Anthropic aligned with the documented image and thinking support", () => {
    expect(
      resolveProviderModelCapabilities({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      }),
    ).toMatchObject({
      provider: "anthropic",
      supportsPromptCaching: true,
      supportsContextEdits: true,
      supportsImageInput: true,
      supportsAudioInput: false,
      supportsAudioOutput: false,
      supportsExtendedThinking: true,
      acceptsImageHistory: true,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: true,
      acceptsReasoningEffort: false,
    });
  });

  it("tracks DeepSeek and Gemini thinking support from the documented defaults", () => {
    expect(
      resolveProviderModelCapabilities({
        provider: "deepseek",
        model: "deepseek-reasoner",
      }),
    ).toMatchObject({
      provider: "deepseek",
      supportsExtendedThinking: true,
      acceptsImageHistory: false,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: true,
      acceptsReasoningEffort: false,
    });

    expect(
      resolveProviderModelCapabilities({
        provider: "gemini",
        model: "gemini-2.5-pro",
      }),
    ).toMatchObject({
      provider: "gemini",
      supportsPromptCaching: false,
      supportsContextEdits: false,
      supportsImageInput: true,
      supportsAudioInput: true,
      supportsAudioOutput: true,
      supportsExtendedThinking: true,
      acceptsImageHistory: true,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: true,
      acceptsReasoningEffort: false,
    });

    expect(
      resolveProviderModelCapabilities({
        provider: "gemini",
        model: "gemini-1.5-pro",
      }),
    ).toMatchObject({
      provider: "gemini",
      supportsAudioInput: true,
      supportsAudioOutput: true,
      acceptsImageHistory: true,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: false,
    });
  });

  it("keeps Ollama image history gated to vision-capable local models", () => {
    expect(
      resolveProviderModelCapabilities({
        provider: "ollama",
        model: "qwen2.5-vl:7b",
      }).acceptsImageHistory,
    ).toBe(true);

    expect(
      resolveProviderModelCapabilities({
        provider: "ollama",
        model: "llama3.1:8b",
      }).acceptsImageHistory,
    ).toBe(false);

    expect(
      resolveProviderModelCapabilities({
        provider: "lmstudio",
        model: "qwen2.5-vl:7b",
      }).acceptsImageHistory,
    ).toBe(true);

    expect(
      resolveProviderModelCapabilities({
        provider: "lmstudio",
        model: "llama3.1:8b",
      }).acceptsImageHistory,
    ).toBe(false);
  });

  it("fails closed for unknown providers", () => {
    expect(
      resolveProviderModelCapabilities({
        provider: "unknown-provider",
        model: "some-model",
      }),
    ).toMatchObject({
      provider: "unknown-provider",
      model: "some-model",
      supportsPromptCaching: false,
      supportsContextEdits: false,
      supportsImageInput: false,
      supportsAudioInput: false,
      supportsAudioOutput: false,
      supportsExtendedThinking: false,
      acceptsImageHistory: false,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: false,
    });
  });
});
