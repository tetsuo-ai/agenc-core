import { describe, expect, test, vi } from "vitest";
import type { AuthBackend } from "../auth/backend.js";
import { AgenCProvider } from "./providers/agenc/index.js";
import { AnthropicProvider } from "./providers/anthropic/adapter.js";
import { BedrockProvider } from "./providers/bedrock/index.js";
import { DeepSeekProvider } from "./providers/deepseek/index.js";
import { GeminiProvider } from "./providers/gemini/index.js";
import { GrokProvider } from "./providers/grok/adapter.js";
import { GroqProvider } from "./providers/groq/index.js";
import { GitHubProvider } from "./providers/github/index.js";
import { LMStudioProvider } from "./providers/lmstudio/index.js";
import { MiniMaxProvider } from "./providers/minimax/index.js";
import { MistralProvider } from "./providers/mistral/index.js";
import { NvidiaNimProvider } from "./providers/nvidia-nim/index.js";
import { OllamaProvider } from "./providers/ollama/adapter.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible/index.js";
import { OpenAIProvider } from "./providers/openai/adapter.js";
import type { OpenAIProviderConfig } from "./providers/openai/types.js";
import { OpenRouterProvider } from "./providers/openrouter/index.js";
import {
  createProvider,
  isFactoryProvider,
  KNOWN_PROVIDER_NAMES,
  normalizeProviderName,
  prepareProviderSwitch,
  readProviderFactoryOptions,
  readProviderIdentity,
  resolveProviderNameFromEnv,
  type ProviderName,
} from "./provider.js";
import { resolveBuiltInProviderInfo } from "./registry/provider-info.js";

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
      model: "grok-4.3",
    }),
    getSubscriptionTier: () => "team",
  };

  test("routes 'grok' to GrokProvider", () => {
    const provider = createProvider("grok", {
      apiKey: "test-key",
      model: "grok-4.3",
    });
    expect(provider).toBeInstanceOf(GrokProvider);
    expect(isFactoryProvider(provider)).toBe(true);
  });

  test("routes 'agenc' to AgenCProvider with explicit auth context", () => {
    const provider = createProvider("agenc", {
      baseURL: "http://127.0.0.1:8000/v1",
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
      baseURL: "http://127.0.0.1:8000/v1",
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

  test.each(KNOWN_PROVIDER_NAMES)(
    "uses provider registry defaults for '%s'",
    (name: ProviderName) => {
      const info = resolveBuiltInProviderInfo(name);
      expect(info).toBeDefined();
      const env: Record<string, string | undefined> = {
        AGENC_MODEL: undefined,
        OPENAI_MODEL: undefined,
        ANTHROPIC_MODEL: undefined,
        OLLAMA_MODEL: undefined,
        LMSTUDIO_MODEL: undefined,
        OPENAI_COMPATIBLE_MODEL: undefined,
        OPENROUTER_MODEL: undefined,
        GROQ_MODEL: undefined,
        DEEPSEEK_MODEL: undefined,
        GEMINI_MODEL: undefined,
        MISTRAL_MODEL: undefined,
        NVIDIA_MODEL: undefined,
        MINIMAX_MODEL: undefined,
        GITHUB_MODEL: undefined,
        AWS_BEDROCK_MODEL: undefined,
        OPENAI_BASE_URL: undefined,
        ANTHROPIC_BASE_URL: undefined,
        OLLAMA_BASE_URL: undefined,
        LMSTUDIO_BASE_URL: undefined,
        OPENAI_COMPATIBLE_BASE_URL: undefined,
        OPENAI_API_BASE: undefined,
        OPENROUTER_BASE_URL: undefined,
        GROQ_BASE_URL: undefined,
        DEEPSEEK_BASE_URL: undefined,
        GEMINI_BASE_URL: undefined,
        MISTRAL_BASE_URL: undefined,
        NVIDIA_BASE_URL: undefined,
        MINIMAX_BASE_URL: undefined,
        GITHUB_BASE_URL: undefined,
        AWS_BEDROCK_BASE_URL: undefined,
        AWS_BEDROCK_REGION: undefined,
        AWS_REGION: undefined,
        AWS_DEFAULT_REGION: undefined,
        XAI_API_KEY: undefined,
        GROK_API_KEY: undefined,
        AGENC_XAI_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        LMSTUDIO_API_KEY: undefined,
        OPENAI_COMPATIBLE_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
        GROQ_API_KEY: undefined,
        DEEPSEEK_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        MISTRAL_API_KEY: undefined,
        NVIDIA_API_KEY: undefined,
        MINIMAX_API_KEY: undefined,
        GITHUB_TOKEN: undefined,
        GH_TOKEN: undefined,
        AWS_BEDROCK_ACCESS_KEY_ID: undefined,
        AWS_ACCESS_KEY_ID: undefined,
        AWS_BEDROCK_SECRET_ACCESS_KEY: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_BEDROCK_SESSION_TOKEN: undefined,
        AWS_SESSION_TOKEN: undefined,
      };
      const providerOptions = name === "agenc"
        ? {
          extra: {
            authBackend,
            sessionId: "session-1",
          },
        }
        : name === "amazon-bedrock"
          ? {
            apiKey: "registry-test-key",
            extra: {
              secretAccessKey: "registry-secret-key",
            },
          }
          : info?.apiKeyEnvVar !== undefined
            ? { apiKey: "registry-test-key" }
            : {};

      const provider = withEnv(env, () => createProvider(name, providerOptions));

      const options = readProviderFactoryOptions(provider);
      expect(options.model).toBe(info?.defaultModel);
      if (name !== "agenc") {
        expect(options.baseURL).toBe(info?.baseURL);
      }
    },
  );

  test("routes 'openai' to OpenAIProvider", () => {
    const provider = withEnv(
      {
        OPENAI_API_KEY: undefined,
      },
      () =>
        createProvider("openai", {
          apiKey: "sk-test",
          model: "gpt-5.4",
        }),
    );
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(isFactoryProvider(provider)).toBe(true);
  });

  test.each([
    { name: "grok", model: "grok-4.3" },
    { name: "openai", model: "gpt-5" },
    { name: "anthropic", model: "claude-opus-4-7" },
    {
      name: "openai-compatible",
      model: "local-model",
      baseURL: "https://llm.agenc.tech/v1",
    },
    { name: "openrouter", model: "openai/gpt-5" },
    { name: "groq", model: "llama-3.3-70b-versatile" },
    { name: "deepseek", model: "deepseek-reasoner" },
    { name: "gemini", model: "gemini-2.5-pro" },
    {
      name: "amazon-bedrock",
      model: "amazon.nova-pro-v1:0",
    },
  ] as const)(
    "vends concrete provider keys through AuthBackend for '$name'",
    async (entry) => {
      const { name, model } = entry;
      const extra = "extra" in entry ? entry.extra : undefined;
      const baseURL = "baseURL" in entry ? entry.baseURL : undefined;
      const vendKey = vi.fn(async (provider: string, sessionId: string) => ({
        provider,
        sessionId,
        apiKey: `vended-${provider}-key`,
        ...(provider === "amazon-bedrock"
          ? {
            secretAccessKey: "vended-aws-secret",
            sessionToken: "vended-aws-session",
            region: "us-west-2",
          }
          : {}),
      }));
      const vendingAuthBackend: AuthBackend = {
        ...authBackend,
        vendKey,
      };

      const provider = createProvider(name, {
        model,
        ...(baseURL !== undefined ? { baseURL } : {}),
        extra: {
          authBackend: vendingAuthBackend,
          sessionId: "session-vend",
          ...(extra ?? {}),
        },
      });

      expect(provider.name).toBe(name);
      expect(isFactoryProvider(provider)).toBe(true);
      await expect(provider.getExecutionProfile?.()).resolves.toMatchObject({
        provider: name,
        model,
      });
      expect(vendKey).toHaveBeenCalledWith(name, "session-vend");
    },
  );

  test.each([
    {
      name: "lmstudio",
      model: "gpt-4o-mini",
      expectedProvider: LMStudioProvider,
    },
    {
      name: "openai-compatible",
      model: "local-model",
      expectedProvider: OpenAICompatibleProvider,
    },
    {
      name: "openai-compatible",
      model: "local-model",
      baseURL: "http://127.0.0.1:8000/v1",
      expectedProvider: OpenAICompatibleProvider,
    },
  ] as const)(
    "does not vend AuthBackend keys for local '$name' endpoints",
    async ({ name, model, baseURL, expectedProvider }) => {
      const vendKey = vi.fn(() => {
        throw new Error("vendKey should not run for local providers");
      });
      const vendingAuthBackend: AuthBackend = {
        ...authBackend,
        vendKey,
      };

      const provider = createProvider(name, {
        model,
        ...(baseURL !== undefined ? { baseURL } : {}),
        extra: {
          authBackend: vendingAuthBackend,
          sessionId: "session-local",
        },
      });

      expect(provider).toBeInstanceOf(expectedProvider);
      await expect(provider.getExecutionProfile?.()).resolves.toMatchObject({
        provider: name,
        model,
      });
      expect(vendKey).not.toHaveBeenCalled();
    },
  );

  test("normalizes Grok model ids for AuthBackend-vended gateway keys", async () => {
    const vendKey = vi.fn(async (provider: string, sessionId: string) => ({
      provider,
      sessionId,
      apiKey: "vended-gateway-key",
      baseUrl: "https://llm.agenc.tech",
    }));
    const vendingAuthBackend: AuthBackend = {
      ...authBackend,
      vendKey,
    };

    const provider = createProvider("grok", {
      model: "grok-4.3",
      extra: {
        authBackend: vendingAuthBackend,
        sessionId: "session-gateway",
      },
    });

    await expect(provider.getExecutionProfile?.()).resolves.toMatchObject({
      provider: "grok",
      model: "xai/grok-4.3",
    });
    expect(vendKey).toHaveBeenCalledWith("grok", "session-gateway");
  });

  test("normalizes Grok model ids for direct managed gateway providers", async () => {
    const provider = createProvider("grok", {
      apiKey: "managed-gateway-key",
      baseURL: "https://llm.agenc.tech",
      model: "grok-code-fast-1",
      extra: { managedGateway: true },
    });

    await expect(provider.getExecutionProfile?.()).resolves.toMatchObject({
      provider: "grok",
      model: "xai/grok-code-fast-1",
    });
    expect(readProviderFactoryOptions(provider)).toMatchObject({
      model: "xai/grok-code-fast-1",
    });
  });

  test("defaults model metadata on AuthBackend-vended providers without explicit model", () => {
    const provider = withEnv(
      {
        OPENAI_MODEL: undefined,
      },
      () =>
        createProvider("openai", {
          extra: {
            authBackend,
            sessionId: "session-default-model",
          },
        }),
    );

    expect((provider as unknown as { config: { model: string } }).config.model)
      .toBe("gpt-5");
    expect(readProviderFactoryOptions(provider).model).toBe("gpt-5");
  });

  test("prepares AuthBackend-vended provider switches without explicit model", () => {
    const prepared = withEnv(
      {
        OPENAI_MODEL: undefined,
      },
      () =>
        prepareProviderSwitch("openai", {
          extra: {
            authBackend,
            sessionId: "session-switch-default-model",
          },
        }),
    );

    expect(prepared.provider).toBe("openai");
    expect(prepared.model).toBe("gpt-5");
    expect(readProviderFactoryOptions(prepared.instance).model).toBe("gpt-5");
  });

  test("keeps env model metadata on AuthBackend-vended providers without explicit model", async () => {
    const provider = withEnv(
      {
        OPENAI_MODEL: "gpt-5.4",
      },
      () =>
        createProvider("openai", {
          extra: {
            authBackend,
            sessionId: "session-env-model",
          },
        }),
    );
    const prepared = withEnv(
      {
        OPENAI_MODEL: "gpt-5.4",
      },
      () =>
        prepareProviderSwitch("openai", {
          extra: {
            authBackend,
            sessionId: "session-env-model-switch",
          },
        }),
    );

    expect((provider as unknown as { config: { model: string } }).config.model)
      .toBe("gpt-5.4");
    expect(readProviderFactoryOptions(provider).model).toBe("gpt-5.4");
    await expect(provider.getExecutionProfile?.()).resolves.toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(prepared.model).toBe("gpt-5.4");
    expect(readProviderFactoryOptions(prepared.instance).model).toBe("gpt-5.4");
  });

  test("uses AuthBackend-vended keys on delegated compatible requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_1",
          model: "openai/gpt-5",
          choices: [
            {
              message: {
                role: "assistant",
                content: "delegated",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 1,
            total_tokens: 5,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const vendKey = vi.fn(async (provider: string, sessionId: string) => ({
      provider,
      sessionId,
      apiKey: "vended-openrouter-key",
      baseUrl: "https://llm.agenc.tech/v1",
    }));
    const vendingAuthBackend: AuthBackend = {
      ...authBackend,
      vendKey,
    };
    const provider = createProvider("openrouter", {
      model: "openai/gpt-5",
      extra: {
        authBackend: vendingAuthBackend,
        sessionId: "session-chat",
        fetchImpl,
      },
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("delegated");
    expect(vendKey).toHaveBeenCalledWith("openrouter", "session-chat");
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://llm.agenc.tech/v1/chat/completions");
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer vended-openrouter-key");
  });

  test("uses AuthBackend-vended Bedrock credentials on delegated requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            message: {
              role: "assistant",
              content: [{ text: "bedrock delegated" }],
            },
          },
          stopReason: "end_turn",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const vendKey = vi.fn(async (provider: string, sessionId: string) => ({
      provider,
      sessionId,
      apiKey: "vended-aws-access",
      secretAccessKey: "vended-aws-secret",
      sessionToken: "vended-aws-session",
      region: "us-west-2",
    }));
    const vendingAuthBackend: AuthBackend = {
      ...authBackend,
      vendKey,
    };
    const provider = createProvider("amazon-bedrock", {
      model: "amazon.nova-pro-v1:0",
      extra: {
        authBackend: vendingAuthBackend,
        sessionId: "session-bedrock",
        secretAccessKey: "stale-aws-secret",
        sessionToken: "stale-aws-session",
        region: "us-east-1",
        fetchImpl,
      },
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("bedrock delegated");
    expect(vendKey).toHaveBeenCalledWith("amazon-bedrock", "session-bedrock");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://bedrock-runtime.us-west-2.amazonaws.com/model/amazon.nova-pro-v1%3A0/converse",
    );
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get("x-amz-security-token")).toBe("vended-aws-session");
    expect(headers.get("authorization")).toContain(
      "Credential=vended-aws-access/",
    );
  });

  test("uses AuthBackend-vended Bedrock access key with explicit non-access credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            message: {
              role: "assistant",
              content: [{ text: "bedrock real contract" }],
            },
          },
          stopReason: "end_turn",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const vendKey = vi.fn(async (provider: string, sessionId: string) => ({
      provider,
      sessionId,
      apiKey: "vended-aws-access",
    }));
    const vendingAuthBackend: AuthBackend = {
      ...authBackend,
      vendKey,
    };
    const provider = createProvider("amazon-bedrock", {
      model: "amazon.nova-pro-v1:0",
      extra: {
        authBackend: vendingAuthBackend,
        sessionId: "session-bedrock-real-contract",
        secretAccessKey: "explicit-aws-secret",
        sessionToken: "explicit-aws-session",
        region: "us-west-2",
        fetchImpl,
      },
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("bedrock real contract");
    expect(vendKey).toHaveBeenCalledWith(
      "amazon-bedrock",
      "session-bedrock-real-contract",
    );
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://bedrock-runtime.us-west-2.amazonaws.com/model/amazon.nova-pro-v1%3A0/converse",
    );
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get("x-amz-security-token")).toBe("explicit-aws-session");
    expect(headers.get("authorization")).toContain(
      "Credential=vended-aws-access/",
    );
  });

  test.each([
    {
      label: "provider",
      vended: {
        provider: "anthropic",
        sessionId: "session-mismatch",
        apiKey: "vended-openai-key",
      },
      expected: /returned provider "anthropic"/,
    },
    {
      label: "sessionId",
      vended: {
        provider: "openai",
        sessionId: "other-session",
        apiKey: "vended-openai-key",
      },
      expected: /returned session "other-session"/,
    },
  ])(
    "rejects AuthBackend-vended provider keys with mismatched $label",
    async ({ vended, expected }) => {
      const vendingAuthBackend: AuthBackend = {
        ...authBackend,
        vendKey: vi.fn(async () => vended),
      };
      const provider = createProvider("openai", {
        model: "gpt-5.4",
        extra: {
          authBackend: vendingAuthBackend,
          sessionId: "session-mismatch",
        },
      });

      await expect(provider.getExecutionProfile?.()).rejects.toThrow(expected);
    },
  );

  test("rejects empty AuthBackend-vended provider keys", async () => {
    const vendKey = vi.fn(async (provider: string, sessionId: string) => ({
      provider,
      sessionId,
      apiKey: " ",
    }));
    const vendingAuthBackend: AuthBackend = {
      ...authBackend,
      vendKey,
    };
    const provider = createProvider("openai", {
      model: "gpt-5.4",
      extra: {
        authBackend: vendingAuthBackend,
        sessionId: "session-empty",
      },
    });

    await expect(provider.getExecutionProfile?.()).rejects.toThrow(
      /AuthBackend\.vendKey\(\) returned an empty key/,
    );
  });

  test("retries AuthBackend vending after transient delegate failures", async () => {
    const vendKey = vi.fn()
      .mockRejectedValueOnce(new Error("temporary vending failure"))
      .mockResolvedValueOnce({
        provider: "openai",
        sessionId: "session-retry",
        apiKey: "vended-openai-key",
      });
    const vendingAuthBackend: AuthBackend = {
      ...authBackend,
      vendKey,
    };
    const provider = createProvider("openai", {
      model: "gpt-5.4",
      extra: {
        authBackend: vendingAuthBackend,
        sessionId: "session-retry",
      },
    });

    await expect(provider.getExecutionProfile?.()).rejects.toThrow(
      /temporary vending failure/,
    );
    await expect(provider.getExecutionProfile?.()).resolves.toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(vendKey).toHaveBeenCalledTimes(2);
  });

  test("re-vends AuthBackend keys after vended expiry", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const vendKey = vi.fn(async (provider: string, sessionId: string) => ({
        provider,
        sessionId,
        apiKey: `vended-openai-key-${vendKey.mock.calls.length}`,
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
      }));
      const vendingAuthBackend: AuthBackend = {
        ...authBackend,
        vendKey,
      };
      const provider = createProvider("openai", {
        model: "gpt-5.4",
        extra: {
          authBackend: vendingAuthBackend,
          sessionId: "session-expiry",
        },
      });

      await expect(provider.getExecutionProfile?.()).resolves.toMatchObject({
        provider: "openai",
        model: "gpt-5.4",
      });
      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
      await expect(provider.getExecutionProfile?.()).resolves.toMatchObject({
        provider: "openai",
        model: "gpt-5.4",
      });

      expect(vendKey).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("preserves optional provider hooks on AuthBackend-vended providers that support them", () => {
    const grok = createProvider("grok", {
      model: "grok-4.3",
      extra: {
        authBackend,
        sessionId: "session-hooks",
      },
    });
    const openai = createProvider("openai", {
      model: "gpt-5.4",
      extra: {
        authBackend,
        sessionId: "session-hooks-openai",
      },
    });

    expect(typeof grok.prewarmStartup).toBe("function");
    expect(typeof grok.retrieveStoredResponse).toBe("function");
    expect(typeof grok.deleteStoredResponse).toBe("function");
    expect(openai.prewarmStartup).toBeUndefined();
    expect(typeof openai.retrieveStoredResponse).toBe("function");
    expect(typeof openai.deleteStoredResponse).toBe("function");
  });

  test.each([
    {
      name: "anthropic",
      model: "claude-opus-4-7",
    },
    {
      name: "amazon-bedrock",
      model: "amazon.nova-pro-v1:0",
    },
  ] as const)(
    "does not expose unsupported optional provider hooks on AuthBackend-vended $name providers",
    ({ name, model }) => {
      const provider = createProvider(name, {
        model,
        extra: {
          authBackend,
          sessionId: `session-no-hooks-${name}`,
        },
      });

      expect(provider.prewarmStartup).toBeUndefined();
      expect(provider.retrieveStoredResponse).toBeUndefined();
      expect(provider.deleteStoredResponse).toBeUndefined();
    },
  );

  test("recreates AuthBackend-vended providers from readProviderFactoryOptions", async () => {
    const vendKey = vi.fn(async (provider: string, sessionId: string) => ({
      provider,
      sessionId,
      apiKey: "vended-openrouter-key",
    }));
    const vendingAuthBackend: AuthBackend = {
      ...authBackend,
      vendKey,
    };
    const provider = createProvider("openrouter", {
      model: "openai/gpt-5",
      extra: {
        authBackend: vendingAuthBackend,
        sessionId: "session-rebuild",
      },
    });

    const options = readProviderFactoryOptions(provider);
    expect(options.apiKey).toBeUndefined();
    expect(options.extra?.authBackend).toBe(vendingAuthBackend);
    expect(options.extra).toMatchObject({
      sessionId: "session-rebuild",
    });

    const rebuilt = createProvider("openrouter", options);
    await expect(rebuilt.getExecutionProfile?.()).resolves.toMatchObject({
      provider: "openrouter",
      model: "openai/gpt-5",
    });
    expect(vendKey).toHaveBeenCalledWith("openrouter", "session-rebuild");
  });

  test("coalesces concurrent AuthBackend vending for a cold provider", async () => {
    let resolveVend!: () => void;
    const vendKey = vi.fn((provider: string, sessionId: string) =>
      new Promise<Awaited<ReturnType<AuthBackend["vendKey"]>>>((resolve) => {
        resolveVend = () =>
          resolve({
            provider,
            sessionId,
            apiKey: "vended-openai-key",
          });
      }),
    );
    const vendingAuthBackend: AuthBackend = {
      ...authBackend,
      vendKey,
    };
    const provider = createProvider("openai", {
      model: "gpt-5.4",
      extra: {
        authBackend: vendingAuthBackend,
        sessionId: "session-concurrent",
      },
    });

    const firstProfile = provider.getExecutionProfile?.();
    const secondProfile = provider.getExecutionProfile?.();
    expect(firstProfile).toBeDefined();
    expect(secondProfile).toBeDefined();
    expect(vendKey).toHaveBeenCalledTimes(1);

    resolveVend();
    await Promise.all([firstProfile, secondProfile]);
    expect(vendKey).toHaveBeenCalledTimes(1);
  });

  test("authBackend without sessionId in factory options fails before vending", () => {
    const vendKey = vi.fn(authBackend.vendKey);
    const vendingAuthBackend: AuthBackend = {
      ...authBackend,
      vendKey,
    };

    expect(() =>
      createProvider("openai", {
        model: "gpt-5.4",
        extra: {
          authBackend: vendingAuthBackend,
        },
      }),
    ).toThrow(/sessionId/);
    expect(vendKey).not.toHaveBeenCalled();
  });

  test("preserves openai-compatible context budget metadata", async () => {
    const provider = withEnv(
      {
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
      },
      () =>
        createProvider("openai", {
          apiKey: "local-token",
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

  test("preserves the live provider identity on openai-compatible providers", () => {
    const provider = withEnv(
      {
        OPENROUTER_API_KEY: undefined,
      },
      () =>
        createProvider("openrouter", {
          apiKey: "or-test",
          model: "openai/gpt-5",
        }),
    );

    expect(provider.name).toBe("openrouter");
    expect(readProviderIdentity(provider)).toBe("openrouter");
  });

  test("routes openai-compatible providers through dedicated adapter classes", () => {
    const compatible = withEnv(
      { OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:8000/v1" },
      () => createProvider("openai-compatible", { model: "self-hosted-coder" }),
    );
    const openrouter = withEnv(
      { OPENROUTER_API_KEY: undefined },
      () =>
        createProvider("openrouter", {
          apiKey: "or-test",
          model: "openai/gpt-5",
        }),
    );
    const groq = withEnv(
      { GROQ_API_KEY: undefined },
      () =>
        createProvider("groq", {
          apiKey: "groq-test",
          model: "llama-3.3-70b-versatile",
        }),
    );
    const deepseek = withEnv(
      { DEEPSEEK_API_KEY: undefined },
      () =>
        createProvider("deepseek", {
          apiKey: "deepseek-test",
          model: "deepseek-reasoner",
        }),
    );
    const mistral = withEnv(
      { MISTRAL_API_KEY: undefined },
      () =>
        createProvider("mistral", {
          apiKey: "mistral-test",
          model: "devstral-latest",
        }),
    );
    const nvidiaNim = withEnv(
      { NVIDIA_API_KEY: undefined },
      () =>
        createProvider("nvidia-nim", {
          apiKey: "nvidia-test",
          model: "nvidia/llama-3.1-nemotron-70b-instruct",
        }),
    );
    const minimax = withEnv(
      { MINIMAX_API_KEY: undefined },
      () =>
        createProvider("minimax", {
          apiKey: "minimax-test",
          model: "MiniMax-M2.5",
        }),
    );
    const github = withEnv(
      { GITHUB_TOKEN: undefined },
      () =>
        createProvider("github", {
          apiKey: "github-test",
          model: "github:copilot",
        }),
    );

    expect(compatible).toBeInstanceOf(OpenAICompatibleProvider);
    expect(openrouter).toBeInstanceOf(OpenRouterProvider);
    expect(groq).toBeInstanceOf(GroqProvider);
    expect(deepseek).toBeInstanceOf(DeepSeekProvider);
    expect(mistral).toBeInstanceOf(MistralProvider);
    expect(nvidiaNim).toBeInstanceOf(NvidiaNimProvider);
    expect(minimax).toBeInstanceOf(MiniMaxProvider);
    expect(github).toBeInstanceOf(GitHubProvider);
  });

  test("normalizes generic openai-compatible provider aliases", () => {
    expect(normalizeProviderName("custom")).toBe("openai-compatible");
    expect(normalizeProviderName("openai_compatible")).toBe("openai-compatible");
    expect(normalizeProviderName("openai-compatible")).toBe("openai-compatible");
  });

  test("adds the required OpenRouter routing headers", () => {
    const provider = withEnv(
      { OPENROUTER_API_KEY: undefined },
      () =>
        createProvider("openrouter", {
          apiKey: "or-test",
          model: "openai/gpt-5",
        }),
    );

    expect(
      (provider as unknown as { config: OpenAIProviderConfig }).config
        .defaultHeaders,
    ).toMatchObject({
      "HTTP-Referer": "https://agenc.tech",
      "X-Title": "AgenC",
    });
  });

  test("normalizes GitHub Copilot aliases case-insensitively", () => {
    const bare = withEnv(
      { GITHUB_TOKEN: undefined },
      () =>
        createProvider("github", {
          apiKey: "github-test",
          model: "GitHub:Copilot",
        }),
    );
    const compound = withEnv(
      { GITHUB_TOKEN: undefined },
      () =>
        createProvider("github", {
          apiKey: "github-test",
          model: "GitHub:Copilot:gpt-5.4",
        }),
    );

    expect((bare as unknown as { config: OpenAIProviderConfig }).config.model)
      .toBe("gpt-4o");
    expect((compound as unknown as { config: OpenAIProviderConfig }).config.model)
      .toBe("gpt-5.4");
  });

  test("uses the documented openai default model when no model override is supplied", () => {
    const provider = withEnv(
      {
        OPENAI_API_KEY: undefined,
        OPENAI_MODEL: undefined,
      },
      () => createProvider("openai", { apiKey: "sk-test" }),
    );
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(
      (provider as unknown as { config: OpenAIProviderConfig }).config.model,
    ).toBe("gpt-5");
  });

  test("routes 'anthropic' to AnthropicProvider", () => {
    const provider = withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
      },
      () =>
        createProvider("anthropic", {
          apiKey: "anthropic-test",
          model: "claude-sonnet-4.5",
        }),
    );
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(isFactoryProvider(provider)).toBe(true);
  });

  test("routes 'amazon-bedrock' to BedrockProvider with AWS SigV4 config", () => {
    const provider = withEnv(
      {
        AWS_BEDROCK_ACCESS_KEY_ID: undefined,
        AWS_BEDROCK_SECRET_ACCESS_KEY: undefined,
        AWS_BEDROCK_SESSION_TOKEN: undefined,
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_SESSION_TOKEN: undefined,
        AWS_BEDROCK_REGION: undefined,
        AWS_BEDROCK_MODEL: undefined,
      },
      () =>
        createProvider("amazon-bedrock", {
          apiKey: "aws-access",
          model: "amazon.nova-lite-v1:0",
          extra: {
            secretAccessKey: "aws-secret",
            sessionToken: "aws-session",
            region: "us-west-2",
          },
        }),
    );

    expect(provider).toBeInstanceOf(BedrockProvider);
    expect(isFactoryProvider(provider)).toBe(true);
    expect(readProviderIdentity(provider)).toBe("amazon-bedrock");
    expect(readProviderFactoryOptions(provider)).toMatchObject({
      baseURL: "https://bedrock-runtime.us-west-2.amazonaws.com",
      model: "amazon.nova-lite-v1:0",
      extra: {
        accessKeyId: "aws-access",
        secretAccessKey: "aws-secret",
        sessionToken: "aws-session",
        region: "us-west-2",
      },
    });
  });

  test("routes generic apiKey to Bedrock accessKeyId", () => {
    const provider = withEnv(
      {
        AWS_BEDROCK_ACCESS_KEY_ID: undefined,
        AWS_ACCESS_KEY_ID: undefined,
        AWS_BEDROCK_SECRET_ACCESS_KEY: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_BEDROCK_MODEL: undefined,
      },
      () =>
        createProvider("amazon-bedrock", {
          apiKey: "configured-access-key",
          model: "amazon.nova-micro-v1:0",
          extra: {
            secretAccessKey: "configured-secret-key",
            region: "us-east-2",
          },
        }),
    );

    expect(provider).toBeInstanceOf(BedrockProvider);
    expect(readProviderFactoryOptions(provider)).toMatchObject({
      model: "amazon.nova-micro-v1:0",
      extra: {
        accessKeyId: "configured-access-key",
        secretAccessKey: "configured-secret-key",
        region: "us-east-2",
      },
    });
  });

  test("keeps Bedrock accessKeyId precedence over generic apiKey", () => {
    const provider = withEnv(
      {
        AWS_BEDROCK_ACCESS_KEY_ID: undefined,
        AWS_ACCESS_KEY_ID: undefined,
        AWS_BEDROCK_SECRET_ACCESS_KEY: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_BEDROCK_MODEL: undefined,
      },
      () =>
        createProvider("amazon-bedrock", {
          apiKey: "generic-access-key",
          model: "amazon.nova-micro-v1:0",
          extra: {
            accessKeyId: "specific-access-key",
            secretAccessKey: "configured-secret-key",
            region: "us-east-2",
          },
        }),
    );

    expect(readProviderFactoryOptions(provider)).toMatchObject({
      extra: {
        accessKeyId: "specific-access-key",
        secretAccessKey: "configured-secret-key",
        region: "us-east-2",
      },
    });
  });

  test("recreates Bedrock provider from factory options with explicit credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            message: {
              role: "assistant",
              content: [{ text: "recreated" }],
            },
          },
          stopReason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = withEnv(
      {
        AWS_BEDROCK_ACCESS_KEY_ID: undefined,
        AWS_ACCESS_KEY_ID: undefined,
        AWS_BEDROCK_SECRET_ACCESS_KEY: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_BEDROCK_SESSION_TOKEN: undefined,
        AWS_SESSION_TOKEN: undefined,
      },
      () =>
        createProvider("amazon-bedrock", {
          apiKey: "configured-access-key",
          model: "amazon.nova-pro-v1:0",
          extra: {
            secretAccessKey: "configured-secret-key",
            sessionToken: "configured-session-token",
            region: "us-west-2",
            fetchImpl,
          },
        }),
    );

    const recreated = withEnv(
      {
        AWS_BEDROCK_ACCESS_KEY_ID: undefined,
        AWS_ACCESS_KEY_ID: undefined,
        AWS_BEDROCK_SECRET_ACCESS_KEY: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_BEDROCK_SESSION_TOKEN: undefined,
        AWS_SESSION_TOKEN: undefined,
      },
      () =>
        createProvider("amazon-bedrock", readProviderFactoryOptions(provider)),
    );

    const response = await recreated.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("recreated");
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(new Headers(init?.headers as HeadersInit).get("x-amz-security-token"))
      .toBe("configured-session-token");
  });

  test("preserves anthropic context-management config in factory state", () => {
    const provider = withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
      },
      () =>
        createProvider("anthropic", {
          apiKey: "anthropic-test",
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

  test("uses the documented anthropic default model when no model override is supplied", () => {
    const provider = withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_MODEL: undefined,
      },
      () => createProvider("anthropic", { apiKey: "anthropic-test" }),
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
        OPENAI_BASE_URL: "http://127.0.0.1:9499/v1",
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
        OPENAI_API_KEY: "wrong-openai-token",
        OPENAI_BASE_URL: "http://127.0.0.1:9499/v1",
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
        OPENAI_BASE_URL: "http://127.0.0.1:9499/v1",
        OPENAI_API_KEY: "wrong-openai-token",
      },
      apiKey: "local-token",
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
        LMSTUDIO_BASE_URL: undefined,
        LMSTUDIO_API_KEY: "ignored-lmstudio-secret",
        OPENAI_BASE_URL: undefined,
      },
      apiKey: "lmstudio-secret",
      model: "qwen2.5-coder:7b",
      expectedBaseURL: "http://localhost:1234/v1",
      expectedModel: "qwen2.5-coder:7b",
      expectedUseResponsesApi: false,
      expectedInstance: LMStudioProvider,
      assertApiKey: true,
      expectedApiKey: "lmstudio-secret",
    },
    {
      name: "openai-compatible",
      env: {
        OPENAI_COMPATIBLE_API_KEY: undefined,
        OPENAI_COMPATIBLE_BASE_URL: undefined,
        OPENAI_COMPATIBLE_MODEL: "self-hosted-coder",
        OPENAI_API_KEY: "wrong-openai-token",
        OPENAI_BASE_URL: "http://127.0.0.1:9000/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      apiKey: "local-token",
      model: undefined,
      expectedBaseURL: "http://127.0.0.1:9000/v1",
      expectedModel: "self-hosted-coder",
      expectedUseResponsesApi: false,
      expectedInstance: OpenAICompatibleProvider,
      assertApiKey: true,
      expectedApiKey: "local-token",
    },
    {
      name: "openrouter",
      env: {
        OPENROUTER_API_KEY: undefined,
        OPENROUTER_BASE_URL: undefined,
        OPENROUTER_MODEL: "openai/gpt-5",
        OPENAI_BASE_URL: "http://127.0.0.1:9499/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      apiKey: "or-test",
      model: undefined,
      expectedBaseURL: "https://openrouter.ai/api/v1",
      expectedModel: "openai/gpt-5",
      expectedUseResponsesApi: false,
      assertApiKey: true,
      expectedApiKey: "or-test",
    },
    {
      name: "openrouter",
      env: {
        OPENROUTER_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
      },
      apiKey: "or-test",
      model: "openai/gpt-5-mini",
      expectedBaseURL: "https://openrouter.ai/api/v1",
      expectedModel: "openai/gpt-5-mini",
      expectedUseResponsesApi: false,
      assertApiKey: true,
      expectedApiKey: "or-test",
    },
    {
      name: "groq",
      env: {
        GROQ_API_KEY: undefined,
        GROQ_BASE_URL: undefined,
        GROQ_MODEL: undefined,
        OPENAI_BASE_URL: "http://127.0.0.1:9499/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      apiKey: "groq-test",
      model: undefined,
      expectedBaseURL: "https://api.groq.com/openai/v1",
      expectedModel: "llama-3.3-70b-versatile",
      expectedUseResponsesApi: false,
      assertApiKey: true,
      expectedApiKey: "groq-test",
    },
    {
      name: "groq",
      env: {
        GROQ_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
      },
      apiKey: "groq-test",
      model: "llama-3.3-70b-versatile",
      expectedBaseURL: "https://api.groq.com/openai/v1",
      expectedModel: "llama-3.3-70b-versatile",
      expectedUseResponsesApi: false,
      assertApiKey: true,
      expectedApiKey: "groq-test",
    },
    {
      name: "deepseek",
      env: {
        DEEPSEEK_API_KEY: undefined,
        DEEPSEEK_BASE_URL: undefined,
        DEEPSEEK_MODEL: undefined,
        OPENAI_BASE_URL: "http://127.0.0.1:9499/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      apiKey: "deepseek-test",
      model: undefined,
      expectedBaseURL: "https://api.deepseek.com/v1",
      expectedModel: "deepseek-reasoner",
      expectedUseResponsesApi: false,
      assertApiKey: true,
      expectedApiKey: "deepseek-test",
    },
    {
      name: "deepseek",
      env: {
        DEEPSEEK_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
      },
      apiKey: "deepseek-test",
      model: "deepseek-reasoner",
      expectedBaseURL: "https://api.deepseek.com/v1",
      expectedModel: "deepseek-reasoner",
      expectedUseResponsesApi: false,
      assertApiKey: true,
      expectedApiKey: "deepseek-test",
    },
    {
      name: "mistral",
      env: {
        MISTRAL_API_KEY: undefined,
        MISTRAL_BASE_URL: undefined,
        MISTRAL_MODEL: undefined,
        OPENAI_BASE_URL: "http://127.0.0.1:19090/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      apiKey: "mistral-test",
      model: undefined,
      expectedBaseURL: "https://api.mistral.ai/v1",
      expectedModel: "devstral-latest",
      expectedUseResponsesApi: false,
      expectedInstance: MistralProvider,
      assertApiKey: true,
      expectedApiKey: "mistral-test",
    },
    {
      name: "nvidia-nim",
      env: {
        NVIDIA_API_KEY: undefined,
        NVIDIA_BASE_URL: undefined,
        NVIDIA_MODEL: undefined,
        OPENAI_BASE_URL: "http://127.0.0.1:19090/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      apiKey: "nvidia-test",
      model: undefined,
      expectedBaseURL: "https://integrate.api.nvidia.com/v1",
      expectedModel: "nvidia/llama-3.1-nemotron-70b-instruct",
      expectedUseResponsesApi: false,
      expectedInstance: NvidiaNimProvider,
      assertApiKey: true,
      expectedApiKey: "nvidia-test",
    },
    {
      name: "minimax",
      env: {
        MINIMAX_API_KEY: undefined,
        MINIMAX_BASE_URL: undefined,
        MINIMAX_MODEL: undefined,
        OPENAI_BASE_URL: "http://127.0.0.1:19090/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      apiKey: "minimax-test",
      model: undefined,
      expectedBaseURL: "https://api.minimax.io/v1",
      expectedModel: "MiniMax-M2.5",
      expectedUseResponsesApi: false,
      expectedInstance: MiniMaxProvider,
      assertApiKey: true,
      expectedApiKey: "minimax-test",
    },
    {
      name: "github",
      env: {
        GITHUB_TOKEN: undefined,
        GITHUB_BASE_URL: undefined,
        GITHUB_MODEL: undefined,
        OPENAI_API_KEY: "sk-openai",
        OPENAI_BASE_URL: "http://127.0.0.1:19090/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      apiKey: "github-test",
      model: undefined,
      expectedBaseURL: "https://api.githubcopilot.com",
      expectedModel: "gpt-4o",
      expectedUseResponsesApi: false,
      expectedInstance: GitHubProvider,
      assertApiKey: true,
      expectedApiKey: "github-test",
    },
    {
      name: "gemini",
      env: {
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        GEMINI_BASE_URL: undefined,
      },
      apiKey: "gemini-test",
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
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        GEMINI_BASE_URL:
          "https://generativelanguage.googleapis.com/v1beta/openai",
      },
      apiKey: "gemini-test",
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
      apiKey,
      model,
      expectedBaseURL,
      expectedModel,
      expectedUseResponsesApi,
      expectedInstance,
      assertApiKey,
      expectedApiKey,
    }) => {
      const provider = withEnv(env, () =>
        createProvider(name, {
          ...(apiKey !== undefined ? { apiKey } : {}),
          ...(model !== undefined ? { model } : {}),
        }),
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

  test("accepts GOOGLE_API_KEY as a Gemini API key", () => {
    const provider = withEnv(
      {
        GOOGLE_API_KEY: "google-test",
        GEMINI_API_KEY: undefined,
        GEMINI_BASE_URL: undefined,
        GEMINI_MODEL: "gemini-2.5-pro",
      },
      () => createProvider("gemini", {}),
    );

    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(readProviderFactoryOptions(provider)).toMatchObject({
      apiKey: "google-test",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-pro",
    });
  });

  test("infers a Vertex Gemini base URL from bearer env credentials", () => {
    const provider = withEnv(
      {
        GOOGLE_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        GEMINI_ACCESS_TOKEN: "ya29-env-token",
        GOOGLE_CLOUD_PROJECT: "project-1",
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_REGION: undefined,
        GEMINI_VERTEX_LOCATION: undefined,
        GEMINI_BASE_URL: undefined,
        GEMINI_MODEL: "gemini-2.5-pro",
      },
      () => createProvider("gemini", {}),
    );

    expect(provider).toBeInstanceOf(GeminiProvider);
    const config = (provider as unknown as {
      config: { accessToken?: string; baseURL?: string; project?: string };
    }).config;
    expect(config.accessToken).toBe("ya29-env-token");
    expect(config.project).toBe("project-1");
    expect(config.baseURL).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1",
    );
  });

  test("honors Gemini access-token auth mode even when GOOGLE_API_KEY is present", () => {
    const provider = withEnv(
      {
        GEMINI_AUTH_MODE: "access-token",
        GOOGLE_API_KEY: "google-test",
        GEMINI_API_KEY: undefined,
        GEMINI_ACCESS_TOKEN: "ya29-env-token",
        GOOGLE_CLOUD_PROJECT: "project-1",
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_REGION: undefined,
        GEMINI_VERTEX_LOCATION: undefined,
        GEMINI_BASE_URL: undefined,
        GEMINI_MODEL: "gemini-2.5-pro",
      },
      () => createProvider("gemini", {}),
    );

    expect(provider).toBeInstanceOf(GeminiProvider);
    const config = (provider as unknown as {
      config: {
        apiKey?: string;
        accessToken?: string;
        baseURL?: string;
        project?: string;
      };
    }).config;
    expect(config.apiKey).toBeUndefined();
    expect(config.accessToken).toBe("ya29-env-token");
    expect(config.project).toBe("project-1");
    expect(config.baseURL).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1",
    );
  });

  test("honors Gemini ADC auth mode even when GOOGLE_API_KEY is present", () => {
    const provider = withEnv(
      {
        GEMINI_AUTH_MODE: "adc",
        GOOGLE_API_KEY: "google-test",
        GEMINI_API_KEY: undefined,
        GEMINI_ACCESS_TOKEN: undefined,
        GOOGLE_CLOUD_PROJECT: "project-1",
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_REGION: undefined,
        GEMINI_VERTEX_LOCATION: undefined,
        GEMINI_BASE_URL: undefined,
        GEMINI_MODEL: "gemini-2.5-pro",
      },
      () => createProvider("gemini", {}),
    );

    expect(provider).toBeInstanceOf(GeminiProvider);
    const config = (provider as unknown as {
      config: { apiKey?: string; baseURL?: string; project?: string };
    }).config;
    expect(config.apiKey).toBeUndefined();
    expect(config.project).toBe("project-1");
    expect(config.baseURL).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1",
    );
  });

  test("tracks the canonical provider identity and rebuild options on openai-compatible providers", () => {
    const provider = withEnv(
      {
        OPENROUTER_API_KEY: undefined,
      },
      () =>
        createProvider("openrouter", {
          apiKey: "or-test",
          model: "openai/gpt-5-mini",
          baseURL: "http://127.0.0.1:19091/api/v1",
        }),
    );

    expect(readProviderIdentity(provider)).toBe("openrouter");
    expect(readProviderFactoryOptions(provider)).toMatchObject({
      apiKey: "or-test",
      baseURL: "http://127.0.0.1:19091/api/v1",
      model: "openai/gpt-5-mini",
    });
  });

  test("tracks generic openai-compatible provider identity and rebuild options", () => {
    const provider = withEnv(
      {
        OPENAI_COMPATIBLE_API_KEY: undefined,
      },
      () =>
        createProvider("openai-compatible", {
          apiKey: "local-token",
          model: "self-hosted-coder",
          baseURL: "http://127.0.0.1:9000/v1",
        }),
    );

    expect(readProviderIdentity(provider)).toBe("openai-compatible");
    expect(readProviderFactoryOptions(provider)).toMatchObject({
      apiKey: "local-token",
      baseURL: "http://127.0.0.1:9000/v1",
      model: "self-hosted-coder",
    });
  });

  test("rebuilds openai provider state from OAuth runtime config without requiring OPENAI_API_KEY", () => {
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

  test("does not vend AuthBackend keys for OAuth config", () => {
    const vendKey = vi.fn(() => {
      throw new Error("vendKey should not run for oauth");
    });
    const oauthAuthBackend: AuthBackend = {
      ...authBackend,
      vendKey,
    };
    const provider = withEnv(
      {
        OPENAI_API_KEY: undefined,
      },
      () =>
        createProvider("openai", {
          model: "gpt-5.4",
          extra: {
            authBackend: oauthAuthBackend,
            sessionId: "session-oauth",
            authMode: "oauth",
            oauth: {
              accessToken: "oauth-access",
              refreshToken: "oauth-refresh",
            },
          },
        }),
    );

    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(vendKey).not.toHaveBeenCalled();
    expect(readProviderFactoryOptions(provider).extra).toMatchObject({
      authMode: "oauth",
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
      name: "mistral",
      env: {
        OPENAI_API_KEY: "sk-openai",
        MISTRAL_API_KEY: undefined,
        MISTRAL_MODEL: "devstral-latest",
      },
      expected: /MISTRAL_API_KEY|apiKey/i,
    },
    {
      name: "nvidia-nim",
      env: {
        OPENAI_API_KEY: "sk-openai",
        NVIDIA_API_KEY: undefined,
        NVIDIA_MODEL: "nvidia/llama-3.1-nemotron-70b-instruct",
      },
      expected: /NVIDIA_API_KEY|apiKey/i,
    },
    {
      name: "minimax",
      env: {
        OPENAI_API_KEY: "sk-openai",
        MINIMAX_API_KEY: undefined,
        MINIMAX_MODEL: "MiniMax-M2.5",
      },
      expected: /MINIMAX_API_KEY|apiKey/i,
    },
    {
      name: "github",
      env: {
        OPENAI_API_KEY: "sk-openai",
        GITHUB_TOKEN: undefined,
        GH_TOKEN: undefined,
        GITHUB_MODEL: "gpt-4o",
      },
      expected: /GITHUB_TOKEN|apiKey/i,
    },
  ] as const)(
    "requires provider-specific auth for $name instead of falling back to unrelated globals",
    ({ name, env, expected }) => {
      withEnv(env, () => {
        expect(() => createProvider(name, {})).toThrow(expected);
      });
    },
  );

  test("does not use OPENAI_API_KEY as LMStudio-compatible auth fallback", () => {
    const provider = withEnv(
      {
        OPENAI_API_KEY: "sk-openai",
        LMSTUDIO_API_KEY: "lmstudio-env-token",
        LMSTUDIO_MODEL: "qwen2.5-coder:7b",
      },
      () => createProvider("lmstudio", {}),
    );

    expect(readProviderFactoryOptions(provider).apiKey).toBeUndefined();
  });

  test("does not use OPENAI_BASE_URL as LMStudio-compatible base URL fallback", () => {
    const provider = withEnv(
      {
        LMSTUDIO_BASE_URL: undefined,
        OPENAI_BASE_URL: "http://127.0.0.1:9499/v1",
      },
      () =>
        createProvider("lmstudio", {
          model: "qwen2.5-coder:7b",
        }),
    );

    const config = (provider as unknown as { config: OpenAIProviderConfig })
      .config;
    expect(config.baseURL).toBe("http://localhost:1234/v1");
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
          createProvider("grok", { model: "grok-4.3" }),
        ).toThrow(/XAI_API_KEY|apiKey/i);
      },
    );
  });

  test("'grok' uses the registry default model without an override", () => {
    const provider = withEnv(
      {
        AGENC_MODEL: undefined,
      },
      () => createProvider("grok", { apiKey: "test-key" }),
    );

    expect(readProviderFactoryOptions(provider).model).toBe("grok-4.3");
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

  test("'openrouter' uses the registry default model without an override", () => {
    const provider = withEnv(
      {
        OPENROUTER_API_KEY: undefined,
        OPENROUTER_MODEL: undefined,
      },
      () => createProvider("openrouter", { apiKey: "or-test" }),
    );

    expect(readProviderFactoryOptions(provider).model).toBe("openai/gpt-5");
  });

  test("'lmstudio' uses the registry default model without an override", () => {
    const provider = withEnv(
      {
        LMSTUDIO_MODEL: undefined,
      },
      () => createProvider("lmstudio", {}),
    );

    expect(readProviderFactoryOptions(provider).model).toBe("gpt-4o-mini");
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
        AGENC_PROVIDER: "  openai  ",
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
