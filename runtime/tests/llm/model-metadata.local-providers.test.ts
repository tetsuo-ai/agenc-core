import { describe, expect, test } from "vitest";

import {
  ModelMetadataResolver,
  ollamaShowUrlFromBaseUrl,
} from "../../src/llm/model-metadata.js";
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
}

function recordingFetch(
  routes: Readonly<Record<string, { status?: number; json: unknown }>>,
): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
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
        env: { [envKey]: "http://127.0.0.1:11434/v1" },
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
    });
  }

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

  test("a non-Ollama server that rejects the native probe still resolves", async () => {
    // The extra POST must never turn a working setup into a failure: an
    // unknown server 404s and the resolver falls through its usual chain.
    const { impl } = recordingFetch({
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
