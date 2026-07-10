import { describe, expect, it } from "vitest";
import {
  markCapabilityDrift,
  markCapabilityVerified,
  normalizeProviderSlug,
  resolveProviderCapabilityEntry,
  resolveProviderModelCapabilities,
  shouldProbeCapabilityEntry,
} from "./capabilities.js";

describe("normalizeProviderSlug", () => {
  it("normalizes xai to grok", () => {
    expect(normalizeProviderSlug("xai")).toBe("grok");
    expect(normalizeProviderSlug(" XAI ")).toBe("grok");
  });
});

describe("resolveProviderModelCapabilities", () => {
  it("uses documented xAI model metadata and enables reasoning effort on supported variants", () => {
    const caps = resolveProviderModelCapabilities({
      provider: "xai",
      model: "grok-4.20-multi-agent-latest",
    });

    expect(caps).toMatchObject({
      provider: "grok",
      model: "grok-4.20-multi-agent-latest",
      supportsToolUse: true,
      supportsPromptCaching: true,
      supportsContextEdits: false,
      supportsImageInput: true,
      supportsVisionInput: true,
      supportsAudioInput: false,
      supportsAudioOutput: false,
      supportsStructuredOutput: true,
      supportsStructuredOutputWithTools: true,
      supportsProviderNativeWebSearch: true,
      supportsExtendedThinking: false,
      acceptsImageHistory: true,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: true,
    });

    expect(
      resolveProviderModelCapabilities({
        provider: "grok",
        model: "grok-4.5",
      }),
    ).toMatchObject({
      provider: "grok",
      supportsToolUse: true,
      supportsImageInput: true,
      supportsStructuredOutput: true,
      acceptsReasoningEffort: true,
    });
  });

  it("treats xAI imagine models as incompatible with image-bearing history", () => {
    const caps = resolveProviderModelCapabilities({
      provider: "grok",
      model: "grok-imagine-image-pro",
    });

    expect(caps.acceptsImageHistory).toBe(false);
    expect(caps.acceptsReasoningEffort).toBe(false);
    expect(caps.supportsStructuredOutput).toBe(false);
  });

  it("tracks documented multimodal and reasoning support by model family", () => {
    expect(
      resolveProviderModelCapabilities({
        provider: "openai",
        model: "gpt-5",
      }),
    ).toMatchObject({
      provider: "openai",
      supportsToolUse: true,
      supportsPromptCaching: true,
      supportsContextEdits: false,
      supportsImageInput: true,
      supportsVisionInput: true,
      supportsAudioInput: false,
      supportsAudioOutput: false,
      supportsStructuredOutput: true,
      supportsStructuredOutputWithTools: true,
      // gpt-5 now resolves via its REGISTERED_MODEL_CATALOG entry, which
      // exposes native web search (supportsSearchTool: true).
      supportsProviderNativeWebSearch: true,
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

  it("uses registered model capability hints for staged provider catalog entries", () => {
    expect(
      resolveProviderModelCapabilities({
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).toMatchObject({
      supportsToolUse: true,
      supportsVisionInput: true,
      supportsStructuredOutput: true,
      supportsStructuredOutputWithTools: true,
      supportsProviderNativeWebSearch: true,
      acceptsReasoningEffort: true,
    });
  });

  it("distinguishes provider-level audio support from history replay support", () => {
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

  it("keeps routed compatible providers fail-closed where the matrix says varies", () => {
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

    expect(
      resolveProviderModelCapabilities({
        provider: "openai-compatible",
        model: "self-hosted-coder",
      }),
    ).toMatchObject({
      provider: "openai-compatible",
      acceptsImageHistory: false,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: false,
    });
  });

  it("tracks hosted chat-compatible adapter capabilities", () => {
    for (const provider of ["mistral", "nvidia-nim", "minimax", "github"]) {
      expect(
        resolveProviderModelCapabilities({
          provider,
          model: "adapter-default",
        }),
      ).toMatchObject({
        provider,
        supportsToolUse: true,
        supportsPromptCaching: false,
        supportsContextEdits: false,
        supportsImageInput: false,
        supportsAudioInput: false,
        supportsAudioOutput: false,
        supportsStructuredOutput: false,
        supportsStructuredOutputWithTools: false,
        supportsProviderNativeWebSearch: false,
        supportsExtendedThinking: false,
        acceptsImageHistory: false,
        acceptsAudioHistory: false,
        acceptsThinkingHistory: false,
        acceptsReasoningEffort: false,
      });
    }
  });

  it("keeps messages-provider image and thinking support aligned with the matrix", () => {
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
      supportsStructuredOutput: true,
      supportsStructuredOutputWithTools: true,
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
      supportsToolUse: false,
      supportsPromptCaching: false,
      supportsContextEdits: false,
      supportsImageInput: false,
      supportsVisionInput: false,
      supportsAudioInput: false,
      supportsAudioOutput: false,
      supportsStructuredOutput: false,
      supportsStructuredOutputWithTools: false,
      supportsProviderNativeWebSearch: false,
      supportsExtendedThinking: false,
      acceptsImageHistory: false,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: false,
    });
  });

  it("applies provider capability overrides from config-driven settings", () => {
    const caps = resolveProviderModelCapabilities({
      provider: "openrouter",
      model: "openai/gpt-5",
      overrides: {
        supportsToolUse: false,
        supportsPromptCaching: true,
        supportsContextEdits: true,
        supportsImageInput: true,
        supportsAudioInput: true,
        supportsAudioOutput: true,
        supportsStructuredOutput: true,
        supportsStructuredOutputWithTools: true,
        supportsProviderNativeWebSearch: true,
        supportsExtendedThinking: true,
        acceptsImageHistory: true,
        acceptsAudioHistory: true,
        acceptsThinkingHistory: true,
        acceptsReasoningEffort: true,
      },
    });

    expect(caps).toMatchObject({
      supportsToolUse: false,
      supportsPromptCaching: true,
      supportsContextEdits: true,
      supportsImageInput: true,
      supportsVisionInput: true,
      supportsAudioInput: true,
      supportsAudioOutput: true,
      supportsStructuredOutput: true,
      supportsStructuredOutputWithTools: true,
      supportsProviderNativeWebSearch: true,
      supportsExtendedThinking: true,
      acceptsImageHistory: true,
      acceptsAudioHistory: true,
      acceptsThinkingHistory: true,
      acceptsReasoningEffort: true,
    });
  });
});

describe("capability registry drift state (I-53)", () => {
  it("marks entries stale when drift is detected", () => {
    const entry = markCapabilityDrift({
      provider: "openai",
      model: "gpt-5",
      detectedAt: Date.UTC(2026, 3, 22),
    });

    expect(entry.stale).toBe(true);
    expect(entry.warning).toBe("capability_drift_detected");
    expect(shouldProbeCapabilityEntry(entry, Date.UTC(2026, 3, 23))).toBe(true);
  });

  it("clears stale drift state after verification", () => {
    markCapabilityDrift({
      provider: "deepseek",
      model: "deepseek-reasoner",
      detectedAt: Date.UTC(2026, 2, 1),
    });
    const verified = markCapabilityVerified({
      provider: "deepseek",
      model: "deepseek-reasoner",
      verifiedAt: Date.UTC(2026, 3, 22),
    });

    expect(verified.stale).toBe(false);
    expect(verified.warning).toBeUndefined();
  });

  it("treats old registry entries as probe candidates", () => {
    const entry = resolveProviderCapabilityEntry({
      provider: "anthropic",
      model: "claude-opus-4-7",
      nowMs: Date.UTC(2026, 5, 30),
    });

    expect(entry.stale).toBe(true);
    expect(shouldProbeCapabilityEntry(entry, Date.UTC(2026, 5, 30))).toBe(true);
  });
});
