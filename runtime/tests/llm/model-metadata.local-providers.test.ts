import { describe, expect, test } from "vitest";

import { defaultConfig, mergeConfigs } from "../../src/config/schema.js";
import {
  CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
  ModelMetadataResolver,
  ollamaShowUrlFromBaseUrl,
} from "../../src/llm/model-metadata.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";
import { modelContextWindow } from "../../src/session/turn-context.js";
import type { AgenCConfig } from "../../src/utils/config.js";

const EMPTY_CONFIG = {} as unknown as AgenCConfig;

/**
 * Recorded from a live Ollama 0.32.15. Its OpenAI-compatible surface reports
 * no context length at all, which is why a local model silently inherited the
 * 128k conservative fallback: qwen2.5-coder:1.5b is really 32k and moondream
 * is really 2k, so the runtime planned against a window up to 62x too large.
 */
const OLLAMA_V1_MODELS = {
  object: "list",
  data: [
    {
      id: "qwen2.5-coder:1.5b",
      object: "model",
      created: 1787325306,
      owned_by: "library",
    },
  ],
};

const OLLAMA_SHOW = {
  capabilities: ["completion", "tools", "insert"],
  model_info: {
    "general.architecture": "qwen2",
    "qwen2.block_count": 28,
    "qwen2.context_length": 32768,
  },
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
  readonly authorization?: string;
}

function recordingFetch(
  routes: Readonly<Record<string, { status?: number; json: unknown }>>,
): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      ...(authorization ? { authorization } : {}),
    });
    const route = routes[url];
    if (route === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(route.json), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("ollamaShowUrlFromBaseUrl", () => {
  test("collapses the OpenAI-compatible surface onto the native API", () => {
    // Ollama's native API sits at the origin while /v1 hosts the compatible
    // surface, so both spellings of the same server must agree.
    expect(ollamaShowUrlFromBaseUrl("http://127.0.0.1:11434")).toBe(
      "http://127.0.0.1:11434/api/show",
    );
    expect(ollamaShowUrlFromBaseUrl("http://127.0.0.1:11434/v1")).toBe(
      "http://127.0.0.1:11434/api/show",
    );
    expect(ollamaShowUrlFromBaseUrl("http://127.0.0.1:11434/v1/")).toBe(
      "http://127.0.0.1:11434/api/show",
    );
    expect(ollamaShowUrlFromBaseUrl("https://box.local:11434")).toBe(
      "https://box.local:11434/api/show",
    );
  });
});

describe("provider metadata identity", () => {
  test("accepts xAI metadata labels without reopening xai as a live selector", () => {
    const resolved = new ModelMetadataResolver({ env: {} }).resolveSync({
      provider: "xai",
      model: "grok-4.6",
      config: EMPTY_CONFIG,
    });

    expect(resolved.source).toBe("built_in_heuristic");
    expect(resolved.contextWindow).toBe(500_000);
  });

  test.each([
    "kimi-k2.7-code",
    "kimi-k2.7-code-highspeed",
    "kimi-k2.6",
  ])("reserves 32768 output tokens for %s without cataloguing an upstream max", (model) => {
    const resolved = new ModelMetadataResolver({ env: {} }).resolveSync({
      provider: "kimi",
      model,
      config: EMPTY_CONFIG,
    });

    expect(resolved).toMatchObject({
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
      // Operational harness safety ceiling, not Moonshot model metadata.
      maxOutputTokensUpperLimit: 64_000,
      source: "built_in_heuristic",
      usedFallbackModelMetadata: false,
    });
  });

  test.each([
    ["grok", "XAI_BASE_URL", "XAI_API_KEY"],
    ["groq", "GROQ_BASE_URL", "GROQ_API_KEY"],
    ["deepseek", "DEEPSEEK_BASE_URL", "DEEPSEEK_API_KEY"],
    ["meta", "META_BASE_URL", "MODEL_API_KEY"],
    ["qwen", "QWEN_BASE_URL", "QWEN_API_KEY"],
    ["qwen-token-plan", "QWEN_TOKEN_PLAN_BASE_URL", "QWEN_TOKEN_PLAN_API_KEY"],
    ["cerebras", "CEREBRAS_BASE_URL", "CEREBRAS_API_KEY"],
    ["lmstudio", "LMSTUDIO_BASE_URL", "LMSTUDIO_API_KEY"],
    ["openai-compatible", "OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_API_KEY"],
  ])("%s only queries its configured API paths", async (provider, baseUrlEnv, apiKeyEnv) => {
    const { impl, calls } = recordingFetch({
      "https://metadata.example/v1/models": {
        json: { object: "list", data: [{ id: "unlisted-model" }] },
      },
    });
    const resolved = await new ModelMetadataResolver({
      fetchImpl: impl,
      env: {
        [baseUrlEnv]: "https://metadata.example/v1",
        [apiKeyEnv]: "provider-key",
      },
    }).resolve({ provider, model: "unlisted-model", config: EMPTY_CONFIG });

    expect(resolved.contextWindow).toBeGreaterThan(0);
    expect(calls[0]).toMatchObject({
      url: "https://metadata.example/v1/models",
      authorization: "Bearer provider-key",
    });
    expect(calls.map((call) => call.url)).not.toContain(
      "https://metadata.example/api/show",
    );
  });

  test("Ollama Cloud still uses its own native API with its own key", async () => {
    const { impl, calls } = recordingFetch({
      "https://ollama.com/api/show": { json: OLLAMA_SHOW },
    });
    const resolved = await new ModelMetadataResolver({
      fetchImpl: impl,
      env: { OLLAMA_API_KEY: "ollama-cloud-key", OPENAI_API_KEY: "hosted-openai-key" },
    }).resolve({
      provider: "ollama-cloud",
      model: "unlisted-model",
      config: EMPTY_CONFIG,
    });

    expect(resolved.contextWindow).toBe(32768);
    expect(calls).toEqual([{
      url: "https://ollama.com/api/show",
      method: "POST",
      body: JSON.stringify({ model: "unlisted-model" }),
      authorization: "Bearer ollama-cloud-key",
    }]);
  });
});

describe("local providers resolve the real context window", () => {
  test("ollama reads the architecture-prefixed context length", async () => {
    const { impl, calls } = recordingFetch({
      "http://127.0.0.1:11434/api/show": { json: OLLAMA_SHOW },
    });
    const resolved = await new ModelMetadataResolver({
      fetchImpl: impl,
      env: { OLLAMA_BASE_URL: "http://127.0.0.1:11434" },
    }).resolve({
      provider: "ollama",
      model: "qwen2.5-coder:1.5b",
      config: EMPTY_CONFIG,
    });

    expect(resolved.contextWindow).toBe(32768);
    expect(resolved.source).toBe("live_endpoint");
    expect(resolved.usedFallbackModelMetadata).toBe(false);
    // The native endpoint is a POST carrying the model, and the OpenAI-shaped
    // models list is never consulted for ollama -- it has nothing to give.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ model: "qwen2.5-coder:1.5b" });
  });

  test("OLLAMA_BASE_URL is honoured instead of the built-in default", async () => {
    // The provider factory already resolved this variable; the metadata
    // lookup used to ignore it and probe localhost while the session talked
    // to another host.
    const { impl, calls } = recordingFetch({
      "http://10.0.0.7:11434/api/show": { json: OLLAMA_SHOW },
    });
    const resolved = await new ModelMetadataResolver({
      fetchImpl: impl,
      env: { OLLAMA_BASE_URL: "http://10.0.0.7:11434" },
    }).resolve({
      provider: "ollama",
      model: "qwen2.5-coder:1.5b",
      config: EMPTY_CONFIG,
    });

    expect(resolved.contextWindow).toBe(32768);
    expect(calls.map((call) => call.url)).toEqual([
      "http://10.0.0.7:11434/api/show",
    ]);
  });

  for (
    const [provider, envKey] of [
      ["openai-compatible", "OPENAI_COMPATIBLE_BASE_URL"],
      ["lmstudio", "LMSTUDIO_BASE_URL"],
    ] as const
  ) {
    test(`${provider} pointed at Ollama falls back to the native probe`, async () => {
      const { impl, calls } = recordingFetch({
        "http://127.0.0.1:11434/v1/models": { json: OLLAMA_V1_MODELS },
        "http://127.0.0.1:11434/api/show": { json: OLLAMA_SHOW },
      });
      const resolved = await new ModelMetadataResolver({
        fetchImpl: impl,
        env: {
          [envKey]: "http://127.0.0.1:11434/v1",
          OPENAI_API_KEY: "hosted-openai-key",
        },
      }).resolve({
        provider,
        model: "qwen2.5-coder:1.5b",
        config: EMPTY_CONFIG,
      });

      expect(resolved.contextWindow).toBe(32768);
      expect(resolved.source).toBe("live_endpoint");
      // The compatible surface is tried first and yields no window, so the
      // native endpoint is consulted second.
      expect(calls.map((call) => call.url)).toEqual([
        "http://127.0.0.1:11434/v1/models",
        "http://127.0.0.1:11434/api/show",
      ]);
      expect(calls[0]!.authorization).toBeUndefined();
      expect(calls[1]!.authorization).toBeUndefined();
    });
  }

  test("the default compatible metadata probe does not borrow the OpenAI key", async () => {
    const { impl, calls } = recordingFetch({
      "http://localhost:8000/v1/models": {
        json: { data: [{ id: "local-model", max_model_len: 8192 }] },
      },
    });
    await new ModelMetadataResolver({
      fetchImpl: impl,
      env: { OPENAI_API_KEY: "hosted-openai-key" },
    }).resolve({
      provider: "openai-compatible",
      model: "local-model",
      config: EMPTY_CONFIG,
    });

    expect(calls[0]?.url).toBe("http://localhost:8000/v1/models");
    expect(calls[0]?.authorization).toBeUndefined();
  });

  test.each([
    ["the default hosted origin", undefined, "https://api.openai.com/v1/models"],
    ["an explicit hosted origin", "https://api.openai.com/v1", "https://api.openai.com/v1/models"],
    ["a custom hosted origin", "https://openai.example/v1", "https://openai.example/v1/models"],
    ["a custom local origin", "http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1/models"],
  ])("OpenAI session startup never queries /api/show at %s", async (_label, baseUrl, modelsUrl) => {
    const { impl, calls } = recordingFetch({
      [modelsUrl]: { json: { object: "list", data: [{ id: "unlisted-model" }] } },
    });
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openai",
      metadata: {
        fetchImpl: impl,
        env: {
          OPENAI_API_KEY: "hosted-openai-key",
          ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
        },
      },
    });

    const info = await manager.getModelInfo("unlisted-model");
    expect(info.contextWindow).toBeGreaterThan(0);
    if (baseUrl) {
      expect(calls[0]).toMatchObject({
        url: modelsUrl,
        authorization: "Bearer hosted-openai-key",
      });
      expect(calls.filter((call) => call.authorization)).toEqual([calls[0]]);
    } else {
      expect(calls.every((call) => call.authorization === undefined)).toBe(true);
    }
    expect(calls.map((call) => call.url)).not.toContain(
      ollamaShowUrlFromBaseUrl(baseUrl ?? "https://api.openai.com/v1"),
    );
  });

  test("a compatible server that already reports a window is not probed twice", async () => {
    // vLLM and friends expose max_model_len on /v1/models; that answer wins
    // and no native request is issued.
    const { impl, calls } = recordingFetch({
      "http://127.0.0.1:8000/v1/models": {
        json: {
          object: "list",
          data: [{ id: "local-model", max_model_len: 8192 }],
        },
      },
    });
    const resolved = await new ModelMetadataResolver({
      fetchImpl: impl,
      env: { OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:8000/v1" },
    }).resolve({
      provider: "openai-compatible",
      model: "local-model",
      config: EMPTY_CONFIG,
    });

    expect(resolved.contextWindow).toBe(8192);
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8000/v1/models",
    ]);
  });

  test("LM Studio metadata never borrows the OpenAI endpoint", async () => {
    const { impl, calls } = recordingFetch({
      "http://localhost:1234/v1/models": {
        json: {
          object: "list",
          data: [{ id: "studio-model", max_model_len: 16_384 }],
        },
      },
    });
    const resolved = await new ModelMetadataResolver({
      fetchImpl: impl,
      env: {
        OPENAI_API_KEY: "unrelated-openai-key",
        OPENAI_BASE_URL: "http://127.0.0.1:9999/v1",
      },
    }).resolve({
      provider: "lmstudio",
      model: "studio-model",
      config: EMPTY_CONFIG,
    });

    expect(resolved.contextWindow).toBe(16_384);
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:1234/v1/models",
    ]);
  });

  test("an unrecognized local server uses the usual metadata fallbacks", async () => {
    const { impl, calls } = recordingFetch({
      "http://127.0.0.1:8000/v1/models": {
        json: { object: "list", data: [{ id: "local-model" }] },
      },
    });
    const resolved = await new ModelMetadataResolver({
      fetchImpl: impl,
      env: { OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:8000/v1" },
    }).resolve({
      provider: "openai-compatible",
      model: "local-model",
      config: EMPTY_CONFIG,
    });

    expect(resolved.source).not.toBe("live_endpoint");
    expect(resolved.contextWindow).toBeGreaterThan(0);
    expect(calls.map((call) => call.url)).not.toContain(
      "http://127.0.0.1:8000/api/show",
    );
  });

  test("llama.cpp reports the window nested under meta", async () => {
    // Recorded from llama-server b10549 started with `-c 4096` on a 32k
    // model: n_ctx is what the server honours, n_ctx_train is the model's
    // trained maximum. Serving 32768 here would be refused at 4097.
    const { impl, calls } = recordingFetch({
      "http://127.0.0.1:8080/v1/models": {
        json: {
          object: "list",
          data: [
            {
              id: "local.gguf",
              object: "model",
              owned_by: "llamacpp",
              meta: {
                vocab_type: 2,
                n_vocab: 151936,
                n_ctx: 4096,
                n_ctx_train: 32768,
                n_embd: 1536,
              },
            },
          ],
        },
      },
    });
    const resolved = await new ModelMetadataResolver({
      fetchImpl: impl,
      env: { OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:8080/v1" },
    }).resolve({
      provider: "openai-compatible",
      model: "local.gguf",
      config: EMPTY_CONFIG,
    });

    expect(resolved.contextWindow).toBe(4096);
    expect(resolved.source).toBe("live_endpoint");
    // The compatible surface answered, so no native endpoint is consulted.
    expect(calls).toHaveLength(1);
  });

  test("llama.cpp falls back to the trained window when none is served", async () => {
    const { impl } = recordingFetch({
      "http://127.0.0.1:8080/v1/models": {
        json: {
          object: "list",
          data: [{ id: "local.gguf", meta: { n_ctx_train: 32768 } }],
        },
      },
    });
    const resolved = await new ModelMetadataResolver({
      fetchImpl: impl,
      env: { OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:8080/v1" },
    }).resolve({
      provider: "openai-compatible",
      model: "local.gguf",
      config: EMPTY_CONFIG,
    });

    expect(resolved.contextWindow).toBe(32768);
  });

  test("a malformed context length is ignored rather than trusted", async () => {
    for (
      const value of [0, -1, 1.5, "32768", null] as const
    ) {
      const { impl } = recordingFetch({
        "http://127.0.0.1:11434/api/show": {
          json: { model_info: { "qwen2.context_length": value } },
        },
      });
      const resolved = await new ModelMetadataResolver({
        fetchImpl: impl,
        env: { OLLAMA_BASE_URL: "http://127.0.0.1:11434" },
      }).resolve({
        provider: "ollama",
        model: "qwen2.5-coder:1.5b",
        config: EMPTY_CONFIG,
      });
      expect(resolved.source, String(value)).not.toBe("live_endpoint");
    }
  });
});

const OLLAMA_SHOW_URL = "http://127.0.0.1:11434/api/show";
const OLLAMA_ENV = { OLLAMA_BASE_URL: "http://127.0.0.1:11434" } as const;

function ollamaShowScriptFetch(
  script: (showCall: number) => Promise<Response> | Response,
): { readonly impl: typeof fetch; readonly showCalls: () => number } {
  let showCalls = 0;
  const impl = (async (input: RequestInfo | URL) => {
    if (String(input) !== OLLAMA_SHOW_URL) {
      return new Response("not found", { status: 404 });
    }
    showCalls += 1;
    return await script(showCalls);
  }) as unknown as typeof fetch;
  return { impl, showCalls: () => showCalls };
}

describe("transient metadata failures do not stick", () => {
  test("a 503 then a valid 32768 window refetches instead of caching undefined", async () => {
    const { impl, showCalls } = ollamaShowScriptFetch((showCall) => {
      if (showCall === 1) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify(OLLAMA_SHOW), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "ollama",
      metadata: { fetchImpl: impl, env: OLLAMA_ENV },
    });

    const first = await manager.getModelInfo("qwen2.5-coder:1.5b");
    expect(first.usedFallbackModelMetadata).toBe(true);
    expect(first.contextWindow).toBe(CONSERVATIVE_CONTEXT_WINDOW_TOKENS);
    expect(showCalls()).toBe(1);

    const second = await manager.getModelInfo("qwen2.5-coder:1.5b");
    expect(second.contextWindow).toBe(32768);
    expect(second.usedFallbackModelMetadata).toBe(false);
    expect(showCalls()).toBe(2);
  });

  test("concurrent ollama lookups share one in-flight /api/show request", async () => {
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { impl, showCalls } = ollamaShowScriptFetch(async (showCall) => {
      if (showCall === 1) await holdFirst;
      return new Response(JSON.stringify(OLLAMA_SHOW), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const resolver = new ModelMetadataResolver({
      fetchImpl: impl,
      env: OLLAMA_ENV,
    });
    const lookup = {
      provider: "ollama",
      model: "qwen2.5-coder:1.5b",
      config: EMPTY_CONFIG,
    };

    const pending = [resolver.resolve(lookup), resolver.resolve(lookup)];
    expect(showCalls()).toBe(1);
    releaseFirst();
    const [left, right] = await Promise.all(pending);
    expect(left.source).toBe("live_endpoint");
    expect(right.source).toBe("live_endpoint");
    expect(left.contextWindow).toBe(32768);
    expect(right.contextWindow).toBe(32768);
    expect(showCalls()).toBe(1);
  });
});

/**
 * DeepSeek's GET /v1/models, recorded 2026-09-25 and trimmed to the fields
 * the resolver reads. The window is spelled `context_window`.
 */
const DEEPSEEK_FLASH_LISTING = {
  id: "deepseek-flash",
  object: "model",
  owned_by: "deepseek",
  context_window: 1_048_576,
  max_output_tokens: 393_216,
} as const;

const DEEPSEEK_LISTING_ENV = {
  DEEPSEEK_API_KEY: "deepseek-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
} as const;

function deepSeekListing(
  entry: Readonly<Record<string, unknown>>,
): ReturnType<typeof recordingFetch> {
  return recordingFetch({
    "https://api.deepseek.com/v1/models": {
      json: { object: "list", data: [entry] },
    },
  });
}

async function resolveFromDeepSeekListing(
  entry: Readonly<Record<string, unknown>>,
) {
  return await new ModelMetadataResolver({
    fetchImpl: deepSeekListing(entry).impl,
    env: DEEPSEEK_LISTING_ENV,
  }).resolve({
    provider: "deepseek",
    model: String(entry.id),
    config: EMPTY_CONFIG,
  });
}

describe("a source that knows a model's limits but not its window", () => {
  test("a DeepSeek base URL keeps deepseek-flash's window for the session", async () => {
    // With DEEPSEEK_BASE_URL set, the models list is read before the catalog.
    // Only its output limit was read, so every turn of the session failed in
    // milliseconds with "Missing context window for model deepseek-flash".
    const { impl, calls } = deepSeekListing(DEEPSEEK_FLASH_LISTING);
    const manager = new StaticModelsManager({
      config: mergeConfigs(defaultConfig(), {
        model_provider: "deepseek",
        model: "deepseek-flash",
      }),
      fallbackProvider: "deepseek",
      metadata: { fetchImpl: impl, env: DEEPSEEK_LISTING_ENV },
    });

    const info = await manager.getModelInfo("deepseek-flash");

    expect(info.contextWindow).toBe(1_048_576);
    expect(modelContextWindow({ modelInfo: info })).toBe(996_147);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.deepseek.com/v1/models",
    ]);
  });

  test("a models list's context_window is the window its endpoint serves", async () => {
    // An endpoint that serves the model with a smaller window than the
    // catalog's: its listing wins, as it does when the field is named
    // context_length.
    const resolved = await resolveFromDeepSeekListing({
      ...DEEPSEEK_FLASH_LISTING,
      context_window: 262_144,
    });

    expect(resolved).toMatchObject({
      contextWindow: 262_144,
      source: "live_endpoint",
    });
  });

  test("a models list with only an output limit keeps the catalog window", async () => {
    const resolved = await resolveFromDeepSeekListing({
      id: "deepseek-flash",
      max_output_tokens: 32_768,
    });

    expect(resolved).toMatchObject({
      contextWindow: 1_048_576,
      maxOutputTokens: 32_768,
      source: "live_endpoint",
      usedFallbackModelMetadata: false,
    });
  });

  test("an output limit alone does not leave an unknown model without a window", async () => {
    // Nothing here knows these models, so they plan against the conservative
    // window, the same one they get when no source answers at all.
    const capped = new ModelMetadataResolver({ env: {} });
    const cappedLookup = {
      provider: "openai",
      model: "unlisted-model",
      config: mergeConfigs(defaultConfig(), {
        providers: { openai: { max_output_tokens: 8_192 } },
      }),
    };

    for (
      const resolved of [
        await resolveFromDeepSeekListing({
          id: "proxy-model",
          max_output_tokens: 8_192,
        }),
        capped.resolveSync(cappedLookup),
        await capped.resolve(cappedLookup),
      ]
    ) {
      expect(resolved).toMatchObject({
        contextWindow: CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: 8_192,
        usedFallbackModelMetadata: true,
      });
    }
  });
});
