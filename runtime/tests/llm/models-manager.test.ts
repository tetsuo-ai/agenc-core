import { describe, expect, it, vi } from "vitest";

import { mergeConfigs, defaultConfig } from "../config/schema.js";
import { StaticModelsManager } from "./models-manager.js";
import { CONSERVATIVE_CONTEXT_WINDOW_TOKENS } from "./model-metadata.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("StaticModelsManager", () => {
  it("returns concrete metadata for known built-in models", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openai",
    });

    // gpt-5 (the openai built-in default) now resolves through the
    // single-source REGISTERED_MODEL_CATALOG entry instead of heuristic
    // fallback, so its metadata matches that registry entry (272k context,
    // reasoning summary "none", the full openai reasoning ladder).
    const info = await manager.getModelInfo("gpt-5");
    expect(info).toMatchObject({
      slug: "gpt-5",
      contextWindow: 272_000,
      effectiveContextWindowPercent: 95,
      defaultReasoningLevel: "medium",
      defaultReasoningSummary: "none",
      truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    });
    expect(info.supportedReasoningLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("lists and resolves registered bundled model catalog entries", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openai",
    });

    const listed = await manager.listModels();
    expect(listed.map((entry) => entry.slug)).toContain("gpt-5.4");
    expect(listed.map((entry) => entry.slug)).not.toContain(
      "codex-auto-review", // branding-scan: allow openai model identifier
    );

    const info = await manager.getModelInfo("gpt-5.4");
    expect(info).toMatchObject({
      slug: "gpt-5.4",
      contextWindow: 272_000,
      defaultReasoningLevel: "xhigh",
      defaultReasoningSummary: "none",
      serviceTiers: [
        {
          id: "priority",
          name: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      usedFallbackModelMetadata: false,
    });
    expect(info.supportedReasoningLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);

    const hidden = await manager.getModelInfo(
      "codex-auto-review", // branding-scan: allow openai model identifier
    );
    expect(hidden).toMatchObject({
      slug: "codex-auto-review", // branding-scan: allow openai model identifier
      visibility: "hide",
      showInPicker: false,
    });
  });

  it("lists configured provider default models alongside built-ins", async () => {
    const manager = new StaticModelsManager({
      config: mergeConfigs(defaultConfig(), {
        providers: {
          openrouter: {
            // branding-scan: allow documented routed Anthropic model identifier
            default_model: "anthropic/claude-3.7-sonnet",
          },
        },
      }),
      fallbackProvider: "openrouter",
    });

    const listed = await manager.listModels();
    expect(listed.map((entry) => entry.slug)).toContain(
      // branding-scan: allow documented routed Anthropic model identifier
      "anthropic/claude-3.7-sonnet",
    );
  });

  it("lists built-in Groq Llama and Mixtral routes", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "groq",
    });

    const listed = await manager.listModels();
    expect(listed.map((entry) => entry.slug)).toEqual(
      expect.arrayContaining([
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant",
        "mixtral-8x7b-32768",
      ]),
    );
  });

  it("lists built-in OpenRouter seed routes", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openrouter",
    });

    const listed = await manager.listModels();
    expect(listed.map((entry) => entry.slug)).toEqual(
      expect.arrayContaining([
        "openai/gpt-5",
        "openai/gpt-5-mini",
        "x-ai/grok-code-fast-1",
      ]),
    );
  });

  it("lists the built-in generic openai-compatible route", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openai-compatible",
    });

    const listed = await manager.listModels();
    expect(listed.map((entry) => entry.slug)).toContain("local-model");
  });

  it("falls back cleanly for unknown slugs while preserving the active provider", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "groq",
    });

    const info = await manager.getModelInfo("custom-local-model");
    expect(info.slug).toBe("custom-local-model");
    expect(info.usedFallbackModelMetadata).toBe(true);
    expect(info.effectiveContextWindowPercent).toBe(100);
  });

  it("uses the configured provider for unknown slugs without an explicit fallback", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const manager = new StaticModelsManager({
      config: mergeConfigs(defaultConfig(), {
        model_provider: "lmstudio",
        providers: {
          lmstudio: {
            default_model: "configured-local-model",
            context_window_tokens: 196_608,
            max_output_tokens: 24_576,
          },
        },
      }),
      metadata: { fetchImpl },
    });

    const info = await manager.getModelInfo("custom-local-model");
    expect(info.contextWindow).toBe(196_608);
    expect(info.maxOutputTokens).toBe(24_576);
    expect(info.usedFallbackModelMetadata).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses explicit provider context metadata before fetching anything", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const manager = new StaticModelsManager({
      config: mergeConfigs(defaultConfig(), {
        model_provider: "lmstudio",
        model: "qwen3.6-35b-a3b-fp8",
        providers: {
          lmstudio: {
            default_model: "qwen3.6-35b-a3b-fp8",
            context_window_tokens: 262_144,
            max_output_tokens: 32_768,
          },
        },
      }),
      fallbackProvider: "lmstudio",
      metadata: { fetchImpl },
    });

    const info = await manager.getModelInfo("qwen3.6-35b-a3b-fp8");
    expect(info.contextWindow).toBe(262_144);
    expect(info.maxOutputTokens).toBe(32_768);
    expect(info.usedFallbackModelMetadata).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caps explicit context metadata at the registered model maximum", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const manager = new StaticModelsManager({
      config: mergeConfigs(defaultConfig(), {
        model_provider: "openai",
        model: "gpt-5.4-mini",
        providers: {
          openai: {
            default_model: "gpt-5.4-mini",
            context_window_tokens: 1_000_000,
          },
        },
      }),
      fallbackProvider: "openai",
      metadata: { fetchImpl },
    });

    const info = await manager.getModelInfo("gpt-5.4-mini");
    expect(info.contextWindow).toBe(272_000);
    expect(info.usedFallbackModelMetadata).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps explicit provider max_output_tokens authoritative", async () => {
    const manager = new StaticModelsManager({
      config: mergeConfigs(defaultConfig(), {
        model_provider: "lmstudio",
        model: "qwen3.6-35b-a3b-fp8",
        max_output_tokens: 12_000,
        capped_default_max_output_tokens: true,
        providers: {
          lmstudio: {
            default_model: "qwen3.6-35b-a3b-fp8",
            context_window_tokens: 262_144,
            max_output_tokens: 60_000,
          },
        },
      }),
      fallbackProvider: "lmstudio",
      metadata: {
        env: {
          AGENC_MAX_OUTPUT_TOKENS: "32_000",
        },
      },
    });

    const info = await manager.getModelInfo("qwen3.6-35b-a3b-fp8");
    expect(info.contextWindow).toBe(262_144);
    expect(info.maxOutputTokens).toBe(60_000);
    expect(info.maxOutputTokensUpperLimit).toBe(60_000);
    expect(info.maxOutputTokensExplicit).toBe(true);
    expect(info.maxOutputTokensCappedDefault).toBe(false);
  });

  it("reads live openai-compatible endpoint metadata for vLLM-style models", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer local-token",
      );
      return jsonResponse({
        data: [
          {
            id: "qwen3.6-35b-a3b-fp8",
            max_model_len: 262_144,
            max_output_tokens: 65_536,
          },
        ],
      });
    });
    const manager = new StaticModelsManager({
      config: mergeConfigs(defaultConfig(), {
        model_provider: "lmstudio",
        model: "qwen3.6-35b-a3b-fp8",
        providers: {
          lmstudio: {
            default_model: "qwen3.6-35b-a3b-fp8",
          },
        },
      }),
      fallbackProvider: "lmstudio",
      metadata: {
        fetchImpl,
        env: {
          OPENAI_API_KEY: "local-token",
          OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
        },
      },
    });

    const info = await manager.getModelInfo("qwen3.6-35b-a3b-fp8");
    expect(info.contextWindow).toBe(262_144);
    expect(info.maxOutputTokens).toBe(65_536);
    expect(info.usedFallbackModelMetadata).toBe(false);
  });

  it("prefers live openai-compatible context over stale configured context", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:8001/v1/models");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer local-token",
      );
      return jsonResponse({
        data: [
          {
            id: "qwen3-coder-next-fp8",
            max_model_len: 65_536,
          },
        ],
      });
    });
    const manager = new StaticModelsManager({
      config: mergeConfigs(defaultConfig(), {
        model_provider: "openai-compatible",
        model: "qwen3-coder-next-fp8",
        providers: {
          "openai-compatible": {
            api_key_env: "OPENAI_COMPATIBLE_API_KEY",
            base_url: "http://127.0.0.1:8001/v1",
            default_model: "qwen3-coder-next-fp8",
            context_window_tokens: 131_072,
            max_output_tokens: 32_768,
          },
        },
      }),
      fallbackProvider: "openai-compatible",
      metadata: {
        fetchImpl,
        env: {
          OPENAI_COMPATIBLE_API_KEY: "local-token",
        },
      },
    });

    const info = await manager.getModelInfo("qwen3-coder-next-fp8");
    expect(info.contextWindow).toBe(65_536);
    expect(info.maxOutputTokens).toBe(32_768);
    expect(info.usedFallbackModelMetadata).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads default generic openai-compatible endpoint metadata without requiring auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://localhost:8000/v1/models");
      expect(init?.headers).toBeUndefined();
      return jsonResponse({
        data: [
          {
            id: "local-model",
            max_model_len: 131_072,
            max_output_tokens: 16_384,
          },
        ],
      });
    });
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openai-compatible",
      metadata: { fetchImpl, env: {} },
    });

    const info = await manager.getModelInfo("local-model");
    expect(info.contextWindow).toBe(131_072);
    expect(info.maxOutputTokens).toBe(16_384);
    expect(info.maxOutputTokensUpperLimit).toBe(16_384);
    expect(info.usedFallbackModelMetadata).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses registry provider defaults for openai-compatible metadata auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://localhost:8000/v1/models");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer compat-token",
      );
      return jsonResponse({
        data: [
          {
            id: "local-model",
            max_model_len: 65_536,
            max_output_tokens: 8_192,
          },
        ],
      });
    });
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openai-compatible",
      metadata: {
        fetchImpl,
        env: { OPENAI_COMPATIBLE_API_KEY: "compat-token" },
      },
    });

    const info = await manager.getModelInfo("local-model");
    expect(info.contextWindow).toBe(65_536);
    expect(info.maxOutputTokens).toBe(8_192);
    expect(info.usedFallbackModelMetadata).toBe(false);
  });

  it("uses OpenRouter registry metadata for OpenRouter models", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("https://openrouter.ai/api/v1/models");
      return jsonResponse({
        data: [
          {
            id: "x-ai/grok-code-fast-1",
            context_length: 256_000,
            top_provider: {
              max_completion_tokens: 64_000,
            },
          },
        ],
      });
    });
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openrouter",
      metadata: { fetchImpl },
    });

    const info = await manager.getModelInfo("openrouter:x-ai/grok-code-fast-1");
    expect(info.contextWindow).toBe(256_000);
    expect(info.maxOutputTokens).toBe(64_000);
    expect(info.usedFallbackModelMetadata).toBe(false);
  });

  it("falls back to models.dev metadata when provider live metadata is unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://api.openai.com/v1/models") {
        return jsonResponse({ data: [] });
      }
      if (url === "https://models.dev/api.json") {
        return jsonResponse({
          openai: {
            models: {
              "gpt-test-model": {
                limit: {
                  context: 321_000,
                  output: 12_345,
                },
              },
            },
          },
        });
      }
      return jsonResponse({});
    });
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openai",
      metadata: { fetchImpl },
    });

    const info = await manager.getModelInfo("openai:gpt-test-model");
    expect(info.contextWindow).toBe(321_000);
    expect(info.maxOutputTokens).toBe(12_345);
    expect(info.usedFallbackModelMetadata).toBe(false);
  });

  it("falls back to LiteLLM metadata after models.dev misses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://api.groq.com/openai/v1/models") {
        return jsonResponse({ data: [] });
      }
      if (url === "https://models.dev/api.json") {
        return jsonResponse({});
      }
      if (
        url ===
        "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
      ) {
        return jsonResponse({
          "groq/custom-groq": {
            max_input_tokens: 99_999,
            max_output_tokens: 7_777,
          },
        });
      }
      return jsonResponse({});
    });
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "groq",
      metadata: { fetchImpl },
    });

    const info = await manager.getModelInfo("groq:custom-groq");
    expect(info.contextWindow).toBe(99_999);
    expect(info.maxOutputTokens).toBe(7_777);
    expect(info.usedFallbackModelMetadata).toBe(false);
  });

  it("uses a conservative fallback when all metadata sources miss", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }));
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "lmstudio",
      metadata: { fetchImpl },
    });

    const info = await manager.getModelInfo("lmstudio:missing-local-model");
    expect(info.contextWindow).toBe(CONSERVATIVE_CONTEXT_WINDOW_TOKENS);
    expect(info.maxOutputTokens).toBe(32_000);
    expect(info.maxOutputTokensUpperLimit).toBe(64_000);
    expect(info.usedFallbackModelMetadata).toBe(true);
    expect(info.effectiveContextWindowPercent).toBe(100);
  });

  it("bounds AGENC_MAX_OUTPUT_TOKENS to the model upper limit", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openai",
      metadata: {
        env: {
          AGENC_MAX_OUTPUT_TOKENS: "32000",
        },
      },
    });

    const info = await manager.getModelInfo("openai:gpt-4o");
    expect(info.contextWindow).toBe(128_000);
    expect(info.maxOutputTokens).toBe(16_384);
    expect(info.maxOutputTokensUpperLimit).toBe(16_384);
    expect(info.maxOutputTokensExplicit).toBe(true);
  });

  it("ignores invalid AGENC_MAX_OUTPUT_TOKENS with diagnostics", async () => {
    const warnings: string[] = [];
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "lmstudio",
      metadata: {
        env: {
          AGENC_MAX_OUTPUT_TOKENS: "bogus",
        },
        onWarn: (message) => warnings.push(message),
      },
    });

    const info = await manager.getModelInfo("lmstudio:missing-local-model");
    expect(info.maxOutputTokens).toBe(32_000);
    expect(warnings).toEqual([
      '[agenc:config] invalid AGENC_MAX_OUTPUT_TOKENS="bogus"; expected a positive integer',
    ]);
  });

  it("uses the optional capped default and marks escalation eligibility", async () => {
    const manager = new StaticModelsManager({
      config: mergeConfigs(defaultConfig(), {
        capped_default_max_output_tokens: true,
      }),
      fallbackProvider: "lmstudio",
    });

    const info = await manager.getModelInfo("lmstudio:missing-local-model");
    expect(info.maxOutputTokens).toBe(8_000);
    expect(info.maxOutputTokensUpperLimit).toBe(64_000);
    expect(info.maxOutputTokensExplicit).toBe(false);
    expect(info.maxOutputTokensCappedDefault).toBe(true);
  });

  it("lets explicit output overrides bypass the capped default", async () => {
    const manager = new StaticModelsManager({
      config: mergeConfigs(defaultConfig(), {
        max_output_tokens: 12_000,
        capped_default_max_output_tokens: true,
      }),
      fallbackProvider: "lmstudio",
    });

    const info = await manager.getModelInfo("lmstudio:missing-local-model");
    expect(info.maxOutputTokens).toBe(12_000);
    expect(info.maxOutputTokensExplicit).toBe(true);
    expect(info.maxOutputTokensCappedDefault).toBe(false);
  });
});
