import { describe, expect, test } from "vitest";
import type { AuthBackend } from "../auth/backend.js";
import { AgenCProvider } from "./providers/agenc/index.js";
import { AnthropicProvider } from "./providers/anthropic/index.js";
import { DeepSeekProvider } from "./providers/deepseek/index.js";
import { GeminiProvider } from "./providers/gemini/index.js";
import { GrokProvider } from "./providers/grok/index.js";
import { GroqProvider } from "./providers/groq/index.js";
import { LMStudioProvider } from "./providers/lmstudio/index.js";
import { OllamaProvider } from "./providers/ollama/index.js";
import { OpenAIProvider } from "./providers/openai/index.js";
import type { OpenAIProviderConfig } from "./providers/openai/index.js";
import { OpenRouterProvider } from "./providers/openrouter/index.js";
import {
  createProvider,
  isFactoryProvider,
  readProviderFactoryOptions,
  readProviderIdentity,
  resolveProviderNameFromEnv,
} from "./provider.js";

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("createProvider", () => {
  const authBackend: AuthBackend = {
    login: () => ({ authenticated: true, provider: "remote" }),
    logout: () => ({ authenticated: false }),
    whoami: () => ({ authenticated: true, provider: "remote" }),
    vendKey: (provider, sessionId) => ({ provider, sessionId, apiKey: "key" }),
    inferAgencModel: () => ({
      provider: "grok",
      model: "grok-4-fast",
    }),
    getSubscriptionTier: () => "team",
  };

  test("routes 'grok' to GrokProvider", () => {
    const provider = createProvider("grok", {
      apiKey: "test-key",
      model: "grok-4-fast",
    });
    expect(provider).toBeInstanceOf(GrokProvider);
    expect(isFactoryProvider(provider)).toBe(true);
  });

  test("routes 'agenc' to AgenCProvider with explicit auth context", () => {
    const provider = createProvider("agenc", {
      baseURL: "https://grok.example/v1",
      model: "agenc",
      extra: {
        authBackend,
        sessionId: "session-1",
        subscriptionTier: "team",
        maxTokens: 2048,
      },
    });

    expect(provider).toBeInstanceOf(AgenCProvider);
    expect(isFactoryProvider(provider)).toBe(true);
    expect(readProviderIdentity(provider)).toBe("agenc");
    expect(readProviderFactoryOptions(provider)).toMatchObject({
      baseURL: "https://grok.example/v1",
      model: "agenc",
      extra: {
        maxTokens: 2048,
      },
    });
    expect(readProviderFactoryOptions(provider).extra).not.toHaveProperty(
      "authBackend",
    );
  });

  test("'agenc' without auth context throws explanatory error", () => {
    expect(() => createProvider("agenc", { model: "agenc" })).toThrow(
      /authBackend/,
    );
    expect(() =>
      createProvider("agenc", {
        model: "agenc",
        extra: { authBackend },
      }),
    ).toThrow(/sessionId/);
  });

  test("routes 'openai' to OpenAIProvider", () => {
    const provider = withEnv(
      {
        OPENAI_API_KEY: "sk-test",
      },
      () =>
        createProvider("openai", {
          model: "gpt-5.4",
        }),
    );
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(isFactoryProvider(provider)).toBe(true);
  });

  test("preserves OpenAI-compatible context budget metadata", async () => {
    const provider = withEnv(
      {
        OPENAI_API_KEY: "local-token",
        OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
      },
      () =>
        createProvider("openai", {
          model: "qwen-local",
          extra: {
            useResponsesApi: false,
            contextWindowTokens: 262_144,
            maxTokens: 8192,
          },
        }),
    );

    const config = (provider as unknown as { config: OpenAIProviderConfig })
      .config;
    expect(config.contextWindowTokens).toBe(262_144);
    expect(readProviderFactoryOptions(provider).extra).toMatchObject({
      contextWindowTokens: 262_144,
      maxTokens: 8192,
    });
    await expect(provider.getExecutionProfile?.()).resolves.toMatchObject({
      contextWindowTokens: 262_144,
      maxOutputTokens: 8192,
    });
  });

  test("preserves the live provider identity on OpenAI-compatible providers", () => {
    const provider = withEnv(
      {
        OPENROUTER_API_KEY: "or-test",
      },
      () =>
        createProvider("openrouter", {
          model: "openai/gpt-5",
        }),
    );

    expect(provider.name).toBe("openrouter");
    expect(readProviderIdentity(provider)).toBe("openrouter");
  });

  test("routes openrouter/groq/deepseek through dedicated adapter classes", () => {
    const openrouter = withEnv(
      { OPENROUTER_API_KEY: "or-test" },
      () => createProvider("openrouter", { model: "openai/gpt-5" }),
    );
    const groq = withEnv(
      { GROQ_API_KEY: "groq-test" },
      () => createProvider("groq", { model: "llama-3.3-70b-versatile" }),
    );
    const deepseek = withEnv(
      { DEEPSEEK_API_KEY: "deepseek-test" },
      () => createProvider("deepseek", { model: "deepseek-reasoner" }),
    );

    expect(openrouter).toBeInstanceOf(OpenRouterProvider);
    expect(groq).toBeInstanceOf(GroqProvider);
    expect(deepseek).toBeInstanceOf(DeepSeekProvider);
  });

  test("adds the required OpenRouter routing headers", () => {
    const provider = withEnv(
      { OPENROUTER_API_KEY: "or-test" },
      () => createProvider("openrouter", { model: "openai/gpt-5" }),
    );

    expect(
      (provider as unknown as { config: OpenAIProviderConfig }).config
        .defaultHeaders,
    ).toMatchObject({
      "HTTP-Referer": "https://github.com/tetsuo-ai/agenc-core",
      "X-Title": "AgenC",
    });
  });

  test("uses the documented OpenAI default model when no model override is supplied", () => {
    const provider = withEnv(
      {
        OPENAI_API_KEY: "sk-test",
        OPENAI_MODEL: undefined,
      },
      () => createProvider("openai", {}),
    );
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(
      (provider as unknown as { config: OpenAIProviderConfig }).config.model,
    ).toBe("gpt-5");
  });

  test("routes 'anthropic' to AnthropicProvider", () => {
    const provider = withEnv(
      {
        ANTHROPIC_API_KEY: "anthropic-test",
      },
      () =>
        createProvider("anthropic", {
          model: "claude-sonnet-4.5",
        }),
    );
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(isFactoryProvider(provider)).toBe(true);
  });

  test("preserves Anthropic context-management config in factory state", () => {
    const provider = withEnv(
      {
        ANTHROPIC_API_KEY: "anthropic-test",
      },
      () =>
        createProvider("anthropic", {
          model: "claude-sonnet-4.5",
          extra: {
            contextManagement: {
              edits: [{ type: "clear_thinking_20251015", keep: "all" }],
            },
          },
        }),
    );

    expect(readProviderFactoryOptions(provider)).toMatchObject({
      model: "claude-sonnet-4.5",
      extra: {
        contextManagement: {
          edits: [{ type: "clear_thinking_20251015", keep: "all" }],
        },
      },
    });
  });

  test("uses the documented Anthropic default model when no model override is supplied", () => {
    const provider = withEnv(
      {
        ANTHROPIC_API_KEY: "anthropic-test",
        ANTHROPIC_MODEL: undefined,
      },
      () => createProvider("anthropic", {}),
    );
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(
      (provider as unknown as { config: { model: string } }).config.model,
    ).toBe("claude-opus-4-7");
  });

  test("routes 'ollama' to OllamaProvider and strips a trailing /v1 host suffix", () => {
    const provider = withEnv(
      {
        OLLAMA_BASE_URL: "http://localhost:11434/v1",
      },
      () =>
        createProvider("ollama", {
          model: "llama3.2",
        }),
    );
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(isFactoryProvider(provider)).toBe(true);
    expect(
      (provider as unknown as { config: { host?: string } }).config.host,
    ).toBe("http://localhost:11434");
  });

  test.each([
    {
      name: "ollama",
      env: {
        OLLAMA_BASE_URL: undefined,
        OLLAMA_MODEL: undefined,
        OPENAI_BASE_URL: "https://wrong.openai.example/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      model: undefined,
      expectedBaseURL: "http://localhost:11434",
      expectedModel: "llama3.3",
    },
    {
      name: "lmstudio",
      env: {
        LMSTUDIO_BASE_URL: undefined,
        LMSTUDIO_MODEL: "qwen2.5-coder:7b",
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
        OPENAI_MODEL: "wrong-openai-model",
      },
      model: undefined,
      expectedBaseURL: "http://localhost:1234/v1",
      expectedModel: "qwen2.5-coder:7b",
      expectedUseResponsesApi: false,
      expectedInstance: LMStudioProvider,
      assertApiKey: true,
      expectedApiKey: undefined,
    },
    {
      name: "lmstudio",
      env: {
        OPENAI_BASE_URL: "http://localhost:1234/v1",
        OPENAI_API_KEY: "local-token",
      },
      model: "qwen2.5-coder:7b",
      expectedBaseURL: "http://localhost:1234/v1",
      expectedModel: "qwen2.5-coder:7b",
      expectedUseResponsesApi: false,
      expectedInstance: LMStudioProvider,
      assertApiKey: true,
      expectedApiKey: "local-token",
    },
    {
      name: "lmstudio",
      env: {
        LMSTUDIO_API_KEY: "lmstudio-secret",
      },
      model: "qwen2.5-coder:7b",
      expectedBaseURL: "http://localhost:1234/v1",
      expectedModel: "qwen2.5-coder:7b",
      expectedUseResponsesApi: false,
      expectedInstance: LMStudioProvider,
      assertApiKey: true,
      expectedApiKey: "lmstudio-secret",
    },
    {
      name: "openrouter",
      env: {
        OPENROUTER_API_KEY: "or-test",
        OPENROUTER_BASE_URL: undefined,
        OPENROUTER_MODEL: "openai/gpt-5",
        OPENAI_BASE_URL: "https://wrong.openai.example/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      model: undefined,
      expectedBaseURL: "https://openrouter.ai/api/v1",
      expectedModel: "openai/gpt-5",
      expectedUseResponsesApi: false,
    },
    {
      name: "openrouter",
      env: {
        OPENROUTER_API_KEY: "or-test",
        OPENAI_BASE_URL: undefined,
      },
      model: "openai/gpt-5-mini",
      expectedBaseURL: "https://openrouter.ai/api/v1",
      expectedModel: "openai/gpt-5-mini",
      expectedUseResponsesApi: false,
    },
    {
      name: "groq",
      env: {
        GROQ_API_KEY: "groq-test",
        GROQ_BASE_URL: undefined,
        GROQ_MODEL: undefined,
        OPENAI_BASE_URL: "https://wrong.openai.example/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      model: undefined,
      expectedBaseURL: "https://api.groq.com/openai/v1",
      expectedModel: "llama-3.3-70b-versatile",
      expectedUseResponsesApi: false,
    },
    {
      name: "groq",
      env: {
        GROQ_API_KEY: "groq-test",
        OPENAI_BASE_URL: undefined,
      },
      model: "llama-3.3-70b-versatile",
      expectedBaseURL: "https://api.groq.com/openai/v1",
      expectedModel: "llama-3.3-70b-versatile",
      expectedUseResponsesApi: false,
    },
    {
      name: "deepseek",
      env: {
        DEEPSEEK_API_KEY: "deepseek-test",
        DEEPSEEK_BASE_URL: undefined,
        DEEPSEEK_MODEL: undefined,
        OPENAI_BASE_URL: "https://wrong.openai.example/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      model: undefined,
      expectedBaseURL: "https://api.deepseek.com/v1",
      expectedModel: "deepseek-reasoner",
      expectedUseResponsesApi: false,
    },
    {
      name: "deepseek",
      env: {
        DEEPSEEK_API_KEY: "deepseek-test",
        OPENAI_BASE_URL: undefined,
      },
      model: "deepseek-reasoner",
      expectedBaseURL: "https://api.deepseek.com/v1",
      expectedModel: "deepseek-reasoner",
      expectedUseResponsesApi: false,
    },
    {
      name: "gemini",
      env: {
        GEMINI_API_KEY: "gemini-test",
        GEMINI_BASE_URL: undefined,
      },
      model: "gemini-2.5-pro",
      expectedBaseURL: "https://generativelanguage.googleapis.com/v1beta",
      expectedModel: "gemini-2.5-pro",
      expectedUseResponsesApi: false,
      expectedInstance: GeminiProvider,
      assertApiKey: true,
      expectedApiKey: "gemini-test",
    },
    {
      name: "gemini",
      env: {
        GEMINI_API_KEY: "gemini-test",
        GEMINI_BASE_URL:
          "https://generativelanguage.googleapis.com/v1beta/openai",
      },
      model: "gemini-2.5-pro",
      expectedBaseURL: "https://generativelanguage.googleapis.com/v1beta",
      expectedModel: "gemini-2.5-pro",
      expectedUseResponsesApi: false,
      expectedInstance: GeminiProvider,
      assertApiKey: true,
      expectedApiKey: "gemini-test",
    },
  ] as const)(
    "routes '$name' through the live provider path without leaking OPENAI globals",
    ({
      name,
      env,
      model,
      expectedBaseURL,
      expectedModel,
      expectedUseResponsesApi,
      expectedInstance,
      assertApiKey,
      expectedApiKey,
    }) => {
      const provider = withEnv(env, () =>
        createProvider(name, model ? { model } : {}),
      );
      if (name === "ollama") {
        expect(provider).toBeInstanceOf(OllamaProvider);
        expect(isFactoryProvider(provider)).toBe(true);
        const config = (provider as unknown as { config: { host?: string; model: string } }).config;
        expect(config.host).toBe(expectedBaseURL);
        expect(config.model).toBe(expectedModel);
      } else {
        expect(provider).toBeInstanceOf(expectedInstance ?? OpenAIProvider);
        expect(isFactoryProvider(provider)).toBe(true);
        const config = (provider as unknown as { config: OpenAIProviderConfig })
          .config;
        expect(config.baseURL).toBe(expectedBaseURL);
        expect(config.model).toBe(expectedModel);
        if (expectedUseResponsesApi !== undefined) {
          expect(config.useResponsesApi).toBe(expectedUseResponsesApi);
        }
        if (assertApiKey === true) {
          expect(config.apiKey).toBe(expectedApiKey);
        }
      }
    },
  );

  test("tracks the canonical provider identity and rebuild options on OpenAI-compatible providers", () => {
    const provider = withEnv(
      {
        OPENROUTER_API_KEY: "or-test",
      },
      () =>
        createProvider("openrouter", {
          model: "openai/gpt-5-mini",
          baseURL: "https://router.example/api/v1",
        }),
    );

    expect(readProviderIdentity(provider)).toBe("openrouter");
    expect(readProviderFactoryOptions(provider)).toMatchObject({
      apiKey: "or-test",
      baseURL: "https://router.example/api/v1",
      model: "openai/gpt-5-mini",
    });
  });

  test("rebuilds OpenAI provider state from OAuth runtime config without requiring OPENAI_API_KEY", () => {
    const provider = withEnv(
      {
        OPENAI_API_KEY: undefined,
      },
      () =>
        createProvider("openai", {
          model: "gpt-5.4",
          extra: {
            authMode: "oauth",
            oauth: {
              accessToken: "oauth-access",
              refreshToken: "oauth-refresh",
            },
            organization: "org-test",
            project: "proj-test",
          },
        }),
    );

    expect(provider).toBeInstanceOf(OpenAIProvider);
    const options = readProviderFactoryOptions(provider);
    expect(options.model).toBe("gpt-5.4");
    expect(options.extra).toMatchObject({
      authMode: "oauth",
      organization: "org-test",
      project: "proj-test",
      oauth: {
        accessToken: "oauth-access",
        refreshToken: "oauth-refresh",
      },
    });
  });

  test.each([
    {
      name: "openrouter",
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENROUTER_API_KEY: undefined,
        OPENROUTER_MODEL: "openai/gpt-5",
      },
      expected: /OPENROUTER_API_KEY|apiKey/i,
    },
    {
      name: "groq",
      env: {
        OPENAI_API_KEY: "sk-openai",
        GROQ_API_KEY: undefined,
        GROQ_MODEL: "llama-3.3-70b-versatile",
      },
      expected: /GROQ_API_KEY|apiKey/i,
    },
    {
      name: "deepseek",
      env: {
        OPENAI_API_KEY: "sk-openai",
        DEEPSEEK_API_KEY: undefined,
        DEEPSEEK_MODEL: "deepseek-reasoner",
      },
      expected: /DEEPSEEK_API_KEY|apiKey/i,
    },
    {
      name: "gemini",
      env: {
        GOOGLE_API_KEY: "google-test",
        GEMINI_API_KEY: undefined,
        GEMINI_MODEL: "gemini-2.5-pro",
      },
      expected: /GEMINI_API_KEY|apiKey/i,
    },
  ] as const)(
    "requires provider-specific auth for $name instead of falling back to unrelated globals",
    ({ name, env, expected }) => {
      withEnv(env, () => {
        expect(() => createProvider(name, {})).toThrow(expected);
      });
    },
  );

  test("uses OPENAI_API_KEY as LMStudio-compatible auth fallback", () => {
    const provider = withEnv(
      {
        OPENAI_API_KEY: "sk-openai",
        LMSTUDIO_API_KEY: undefined,
        LMSTUDIO_MODEL: "qwen2.5-coder:7b",
      },
      () => createProvider("lmstudio", {}),
    );

    expect(readProviderFactoryOptions(provider).apiKey).toBe("sk-openai");
  });

  test("'grok' without apiKey throws explanatory error", () => {
    withEnv(
      {
        XAI_API_KEY: undefined,
        GROK_API_KEY: undefined,
        AGENC_XAI_API_KEY: undefined,
      },
      () => {
        expect(() =>
          createProvider("grok", { model: "grok-4-fast" }),
        ).toThrow(/XAI_API_KEY|apiKey/i);
      },
    );
  });

  test("'grok' without model throws explanatory error", () => {
    expect(() =>
      createProvider("grok", { apiKey: "test-key" }),
    ).toThrow(/AGENC_MODEL|model/i);
  });

  test("'openai' without apiKey throws explanatory error", () => {
    withEnv(
      {
        OPENAI_API_KEY: undefined,
      },
      () => {
        expect(() =>
          createProvider("openai", { model: "gpt-5.4" }),
        ).toThrow(/OPENAI_API_KEY|apiKey/i);
      },
    );
  });

  test("'openrouter' without a configured model throws explanatory error", () => {
    withEnv(
      {
        OPENROUTER_API_KEY: "or-test",
        OPENROUTER_MODEL: undefined,
      },
      () => {
        expect(() => createProvider("openrouter", {})).toThrow(
          /OPENROUTER_MODEL|model/i,
        );
      },
    );
  });

  test("'lmstudio' without a configured model throws explanatory error", () => {
    withEnv(
      {
        LMSTUDIO_MODEL: undefined,
      },
      () => {
        expect(() => createProvider("lmstudio", {})).toThrow(
          /LMSTUDIO_MODEL|model/i,
        );
      },
    );
  });

  test("unknown provider string bypassing the type system throws", () => {
    expect(() =>
      createProvider("bogus" as unknown as "grok", {
        apiKey: "x",
        model: "y",
      }),
    ).toThrow(/unknown provider/i);
  });
});

describe("resolveProviderNameFromEnv", () => {
  test("defaults to 'grok' when AGENC_PROVIDER unset", () => {
    withEnv(
      {
        AGENC_PROVIDER: undefined,
      },
      () => {
        expect(resolveProviderNameFromEnv()).toBe("grok");
      },
    );
  });

  test("normalizes the xai alias to grok", () => {
    withEnv(
      {
        AGENC_PROVIDER: "xai",
      },
      () => {
        expect(resolveProviderNameFromEnv()).toBe("grok");
      },
    );
  });

  test("lowercases and trims AGENC_PROVIDER", () => {
    withEnv(
      {
        AGENC_PROVIDER: "  OpenAI  ",
      },
      () => {
        expect(resolveProviderNameFromEnv()).toBe("openai");
      },
    );
  });

  test("rejects unknown provider names", () => {
    withEnv(
      {
        AGENC_PROVIDER: "bogus",
      },
      () => {
        expect(() => resolveProviderNameFromEnv()).toThrow(
          /not a known provider/i,
        );
      },
    );
  });
});
