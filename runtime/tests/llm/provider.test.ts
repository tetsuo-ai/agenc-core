import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JWT } from "google-auth-library";
import type { AuthBackend } from "../auth/backend.js";
import { AgenCProvider } from "./providers/agenc/index.js";
import { AnthropicProvider } from "./providers/anthropic/adapter.js";
import { BedrockProvider } from "./providers/bedrock/index.js";
import { DeepSeekProvider } from "./providers/deepseek/index.js";
import {
  GeminiProvider,
  type GeminiProviderConfig,
} from "./providers/gemini/index.js";
import { createGeminiEndpointPlan } from "./providers/gemini/endpoint-plan.js";
import { GrokProvider } from "./providers/grok/adapter.js";
import { GrokAcpProvider } from "./providers/grok/acp-adapter.js";
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
  prepareProviderSwitch,
  readProviderFactoryOptions,
  readProviderIdentity,
  type ProviderName,
} from "./provider.js";
import { resolveProviderFactoryOptions } from "./provider-options.js";
import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  resolveBuiltInProviderInfo,
} from "./registry/provider-info.js";

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
    vendKey: (provider, sessionId) => ({
      provider,
      sessionId,
      kind: "api-key",
      apiKey: "key",
    }),
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

  test("rejects composer construction without a prepared child environment", () => {
    expect(() =>
      createProvider("grok", {
        model: "grok-composer-2.5-fast",
      }),
    ).toThrow(
      "grok composer provider requires a prepared child environment in factory options extra",
    );
  });

  test("binds composer credentials to the creating session", () => {
    const provider = withEnv(
      {
        XAI_API_KEY: "daemon-xai-key",
        GROK_API_KEY: "daemon-grok-key",
      },
      () =>
        createProvider("grok", {
          apiKey: "session-grok-key",
          model: "grok-composer-2.5-fast",
          extra: {
            grokAcp: {
              environment: {
                PATH: "/client/bin",
                HOME: "/client/home",
              },
            },
          },
        }),
    );

    expect(provider).toBeInstanceOf(GrokAcpProvider);
    const environment = (
      provider as unknown as {
        config: { env: NodeJS.ProcessEnv };
      }
    ).config.env;
    expect(environment.XAI_API_KEY).toBe("session-grok-key");
    expect(environment.GROK_API_KEY).toBeUndefined();
    expect(environment.PATH).toBe("/client/bin");
    expect(environment.HOME).toBe("/client/home");
    expect(readProviderFactoryOptions(provider).apiKey).toBe(
      "session-grok-key",
    );
  });

  test("binds composer execution to an explicit child environment", () => {
    const childEnvironment = {
      PATH: "/client/bin",
      HOME: "/client/home",
      LANG: "en_CA.UTF-8",
    };
    const provider = withEnv(
      {
        AGENC_GROK_CLI: "/daemon/bin/grok",
        AGENC_GROK_ACP_PERMISSIONS: "allow",
      },
      () =>
        createProvider("grok", {
          model: "grok-composer-2.5-fast",
          extra: {
            grokAcp: { environment: childEnvironment },
          },
        }),
    );

    childEnvironment.PATH = "/mutated/bin";
    const internal = provider as unknown as {
      config: {
        env: NodeJS.ProcessEnv;
        allowPermissions?: boolean;
      };
      resolveBinary(): string | undefined;
    };
    expect(internal.config.env).toMatchObject({
      PATH: "/client/bin",
      HOME: "/client/home",
      LANG: "en_CA.UTF-8",
    });
    expect(internal.config.env.AGENC_GROK_CLI).toBeUndefined();
    expect(internal.config.env.AGENC_GROK_ACP_PERMISSIONS).toBeUndefined();
    expect(internal.config.allowPermissions).toBeUndefined();
    expect(internal.resolveBinary()).toBeUndefined();
    const returnedEnvironment = (
      readProviderFactoryOptions(provider).extra?.grokAcp as {
        environment: NodeJS.ProcessEnv;
      }
    ).environment;
    expect(returnedEnvironment.PATH).toBe("/client/bin");
    expect(Object.isFrozen(returnedEnvironment)).toBe(true);
    try {
      returnedEnvironment.PATH = "/tampered/bin";
    } catch {
      // Frozen snapshots throw in strict mode and remain unchanged everywhere.
    }
    expect(
      (
        readProviderFactoryOptions(provider).extra?.grokAcp as {
          environment: NodeJS.ProcessEnv;
        }
      ).environment.PATH,
    ).toBe("/client/bin");
  });

  test("preserves configured tools in factory accounting options", () => {
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "lookup",
          description: "Look up a value",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const provider = createProvider("grok", {
      apiKey: "test-key",
      model: "grok-4.3",
      tools,
    });

    expect(readProviderFactoryOptions(provider).tools).toEqual(tools);
  });

  test("preserves factory Gemini cached-content through the native request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "cached" }] },
              finishReason: "STOP",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = createProvider(
      "gemini",
      resolveProviderFactoryOptions(
        "gemini",
        { model: "gemini-2.5-pro", extra: { fetchImpl } },
        {
          GEMINI_API_KEY: "gemini-key",
          GEMINI_CACHED_CONTENT: "cachedContents/project-context",
        },
      ),
    );

    expect(readProviderFactoryOptions(provider).extra).toMatchObject({
      gemini: {
        credentialPlan: {
          kind: "api-key",
          credential: "gemini-key",
          source: "GEMINI_API_KEY",
        },
        cachedContent: "cachedContents/project-context",
      },
    });
    await provider.chat([{ role: "user", content: "hello" }]);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      cachedContent: "cachedContents/project-context",
    });
  });

  test("materializes a factory-selected ADC plan on the native request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agenc-gemini-factory-adc-"));
    const credentialPath = join(directory, "service-account.json");
    writeFileSync(
      credentialPath,
      JSON.stringify({
        type: "service_account",
        client_email: "service@example.test",
        private_key:
          "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
        project_id: "resource-project",
        quota_project_id: "billing-project",
      }),
    );
    let tokenRequests = 0;
    const token = vi
      .spyOn(JWT.prototype, "getAccessToken")
      .mockImplementation(async () => ({
        token: `adc-request-token-${++tokenRequests}`,
        res: null,
      }));
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { role: "model", parts: [{ text: "adc" }] },
                finishReason: "STOP",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    try {
      const provider = createProvider(
        "gemini",
        resolveProviderFactoryOptions(
          "gemini",
          { model: "gemini-2.5-pro", extra: { fetchImpl } },
          {
            GEMINI_AUTH_MODE: "adc",
            GOOGLE_APPLICATION_CREDENTIALS: credentialPath,
            GOOGLE_CLOUD_LOCATION: "us-central1",
            GOOGLE_CLOUD_PROJECT: "resource-project",
            GOOGLE_CLOUD_QUOTA_PROJECT: "billing-project",
          },
        ),
      );

      await provider.chat([{ role: "user", content: "hello" }]);
      await provider.chat([{ role: "user", content: "again" }]);
      const firstHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
      const secondHeaders = fetchImpl.mock.calls[1]?.[1]?.headers as Headers;
      expect(firstHeaders.get("authorization")).toBe(
        "Bearer adc-request-token-1",
      );
      expect(secondHeaders.get("authorization")).toBe(
        "Bearer adc-request-token-2",
      );
      expect(firstHeaders.get("x-goog-user-project")).toBe("billing-project");
      expect(secondHeaders.get("x-goog-user-project")).toBe("billing-project");
      expect(tokenRequests).toBe(2);
      expect(readProviderFactoryOptions(provider).extra).toMatchObject({
        gemini: {
          credentialPlan: {
            kind: "adc",
            credentialPath,
            source: "GOOGLE_APPLICATION_CREDENTIALS",
          },
          endpointPlan: {
            kind: "vertex",
            project: "resource-project",
            location: "us-central1",
            nativeBaseURL:
              "https://us-central1-aiplatform.googleapis.com/v1/projects/resource-project/locations/us-central1/publishers/google",
          },
        },
      });
      expect(readProviderFactoryOptions(provider).baseURL).toBeUndefined();
    } finally {
      token.mockRestore();
      rmSync(directory, { force: true, recursive: true });
    }
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
      const providerOptions =
        name === "agenc"
          ? {
              extra: {
                authBackend,
                sessionId: "session-1",
              },
            }
          : name === "gemini"
            ? resolveProviderFactoryOptions(
                "gemini",
                {},
                { GEMINI_API_KEY: "registry-test-key" },
              )
            : name === "amazon-bedrock"
              ? {
                  extra: {
                    accessKeyId: "registry-test-key",
                    secretAccessKey: "registry-secret-key",
                  },
                }
              : info?.credentials.kind === "api-key"
                ? { apiKey: "registry-test-key" }
                : {};

      const provider = withEnv(env, () =>
        createProvider(name, providerOptions),
      );

      const options = readProviderFactoryOptions(provider);
      expect(options.model).toBe(info?.defaultModel);
      if (name === "gemini") {
        expect(options.apiKey).toBeUndefined();
        expect(options.baseURL).toBeUndefined();
        expect(options.extra).toMatchObject({
          gemini: {
            credentialPlan: {
              kind: "api-key",
              credential: "registry-test-key",
              source: "GEMINI_API_KEY",
            },
            endpointPlan: {
              kind: "developer",
              nativeBaseURL: "https://generativelanguage.googleapis.com/v1beta",
            },
          },
        });
      } else if (name !== "agenc") {
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
    { name: "deepseek", model: "deepseek-v4-pro" },
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
      const vendKey = vi.fn(async (provider: string, sessionId: string) =>
        provider === "amazon-bedrock"
          ? {
              provider,
              sessionId,
              kind: "aws-sigv4" as const,
              accessKeyId: "vended-aws-access",
              secretAccessKey: "vended-aws-secret",
              sessionToken: "vended-aws-session",
              region: "us-west-2",
            }
          : {
              provider,
              sessionId,
              kind: "api-key" as const,
              apiKey: `vended-${provider}-key`,
            },
      );
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

  test("never asks AuthBackend to vend Gemini credentials", () => {
    const vendKey = vi.fn(authBackend.vendKey);
    const provider = createProvider("gemini", {
      model: "gemini-2.5-pro",
      extra: {
        authBackend: { ...authBackend, vendKey },
        sessionId: "session-gemini",
        gemini: {
          credentialPlan: {
            kind: "api-key",
            credential: "canonical-key",
            source: "factory",
          },
          endpointPlan: createGeminiEndpointPlan(),
        },
      },
    });
    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(vendKey).not.toHaveBeenCalled();
  });

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

  test("normalizes OpenRouter model ids for AuthBackend-vended gateway keys", async () => {
    const vendKey = vi.fn(async (provider: string, sessionId: string) => ({
      provider,
      sessionId,
      kind: "api-key" as const,
      apiKey: "vended-gateway-key",
      baseUrl: "https://llm.agenc.tech",
    }));
    const vendingAuthBackend: AuthBackend = {
      ...authBackend,
      vendKey,
    };

    const provider = createProvider("openrouter", {
      model: "x-ai/grok-4.3",
      extra: {
        authBackend: vendingAuthBackend,
        sessionId: "session-gateway",
      },
    });

    await expect(provider.getExecutionProfile?.()).resolves.toMatchObject({
      provider: "openrouter",
      model: "openrouter/x-ai/grok-4.3",
    });
    expect(vendKey).toHaveBeenCalledWith("openrouter", "session-gateway");
  });

  test("normalizes OpenRouter model ids for direct managed gateway providers", async () => {
    const provider = createProvider("openrouter", {
      apiKey: "managed-gateway-key",
      baseURL: "https://llm.agenc.tech",
      model: "x-ai/grok-build-0.1",
      extra: { managedGateway: true },
    });

    await expect(provider.getExecutionProfile?.()).resolves.toMatchObject({
      provider: "openrouter",
      model: "openrouter/x-ai/grok-build-0.1",
    });
    expect(readProviderFactoryOptions(provider)).toMatchObject({
      model: "openrouter/x-ai/grok-build-0.1",
    });
  });

  test("defaults model metadata on AuthBackend-vended providers without explicit model", () => {
    const provider = createProvider("openai", {
      extra: {
        authBackend,
        sessionId: "session-default-model",
      },
    });

    expect(
      (provider as unknown as { config: { model: string } }).config.model,
    ).toBe("gpt-5");
    expect(readProviderFactoryOptions(provider).model).toBe("gpt-5");
  });

  test("prepares AuthBackend-vended provider switches without explicit model", () => {
    const prepared = prepareProviderSwitch("openai", {
      extra: {
        authBackend,
        sessionId: "session-switch-default-model",
      },
    });

    expect(prepared.provider).toBe("openai");
    expect(prepared.model).toBe("gpt-5");
    expect(readProviderFactoryOptions(prepared.instance).model).toBe("gpt-5");
  });

  test("does not let ambient provider-specific model env change factory selection", async () => {
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

    expect(
      (provider as unknown as { config: { model: string } }).config.model,
    ).toBe("gpt-5");
    expect(readProviderFactoryOptions(provider).model).toBe("gpt-5");
    await expect(provider.getExecutionProfile?.()).resolves.toMatchObject({
      provider: "openai",
      model: "gpt-5",
    });
    expect(prepared.model).toBe("gpt-5");
    expect(readProviderFactoryOptions(prepared.instance).model).toBe("gpt-5");
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
      kind: "api-key" as const,
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
      kind: "aws-sigv4" as const,
      accessKeyId: "vended-aws-access",
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

  test("does not combine partial explicit Bedrock credentials with managed vending", () => {
    const vendKey = vi.fn(async (provider: string, sessionId: string) => ({
      provider,
      sessionId,
      kind: "aws-sigv4" as const,
      accessKeyId: "vended-aws-access",
      secretAccessKey: "vended-aws-secret",
    }));
    const vendingAuthBackend: AuthBackend = {
      ...authBackend,
      vendKey,
    };
    expect(() =>
      createProvider("amazon-bedrock", {
        model: "amazon.nova-pro-v1:0",
        extra: {
          authBackend: vendingAuthBackend,
          sessionId: "session-bedrock-partial",
          secretAccessKey: "explicit-aws-secret",
          sessionToken: "explicit-aws-session",
          region: "us-west-2",
        },
      }),
    ).toThrow(/requires accessKeyId/u);
    expect(vendKey).not.toHaveBeenCalled();
  });

  test.each([
    {
      label: "provider",
      vended: {
        provider: "anthropic",
        sessionId: "session-mismatch",
        kind: "api-key" as const,
        apiKey: "vended-openai-key",
      },
      expected: /returned provider "anthropic"/,
    },
    {
      label: "sessionId",
      vended: {
        provider: "openai",
        sessionId: "other-session",
        kind: "api-key" as const,
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

  test.each([
    {
      provider: "openai" as const,
      model: "gpt-5.4",
      vended: {
        provider: "openai",
        sessionId: "session-kind",
        kind: "aws-sigv4" as const,
        accessKeyId: "aws-access",
        secretAccessKey: "aws-secret",
      },
      expected: /expected api-key/u,
    },
    {
      provider: "amazon-bedrock" as const,
      model: "amazon.nova-pro-v1:0",
      vended: {
        provider: "amazon-bedrock",
        sessionId: "session-kind",
        kind: "api-key" as const,
        apiKey: "not-an-aws-access-key",
      },
      expected: /expected aws-sigv4/u,
    },
  ])(
    "rejects $provider managed credentials of the wrong kind",
    async ({ provider: name, model, vended, expected }) => {
      const provider = createProvider(name, {
        model,
        extra: {
          authBackend: {
            ...authBackend,
            vendKey: vi.fn(async () => vended),
          },
          sessionId: "session-kind",
        },
      });

      await expect(provider.getExecutionProfile?.()).rejects.toThrow(expected);
    },
  );

  test("rejects empty AuthBackend-vended provider keys", async () => {
    const vendKey = vi.fn(async (provider: string, sessionId: string) => ({
      provider,
      sessionId,
      kind: "api-key" as const,
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
      /AuthBackend\.vendKey\(\) returned an empty API key/,
    );
  });

  test("retries AuthBackend vending after transient delegate failures", async () => {
    const vendKey = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary vending failure"))
      .mockResolvedValueOnce({
        provider: "openai",
        sessionId: "session-retry",
        kind: "api-key" as const,
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
        kind: "api-key" as const,
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
      kind: "api-key" as const,
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
    const vendKey = vi.fn(
      (provider: string, sessionId: string) =>
        new Promise<Awaited<ReturnType<AuthBackend["vendKey"]>>>((resolve) => {
          resolveVend = () =>
            resolve({
              provider,
              sessionId,
              kind: "api-key",
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
    const openrouter = withEnv({ OPENROUTER_API_KEY: undefined }, () =>
      createProvider("openrouter", {
        apiKey: "or-test",
        model: "openai/gpt-5",
      }),
    );
    const groq = withEnv({ GROQ_API_KEY: undefined }, () =>
      createProvider("groq", {
        apiKey: "groq-test",
        model: "llama-3.3-70b-versatile",
      }),
    );
    const deepseek = withEnv({ DEEPSEEK_API_KEY: undefined }, () =>
      createProvider("deepseek", {
        apiKey: "deepseek-test",
        model: "deepseek-v4-pro",
      }),
    );
    const mistral = withEnv({ MISTRAL_API_KEY: undefined }, () =>
      createProvider("mistral", {
        apiKey: "mistral-test",
        model: "mistral-medium-latest",
      }),
    );
    const nvidiaNim = withEnv({ NVIDIA_API_KEY: undefined }, () =>
      createProvider("nvidia-nim", {
        apiKey: "nvidia-test",
        model: "nvidia/llama-3.1-nemotron-70b-instruct",
      }),
    );
    const minimax = withEnv({ MINIMAX_API_KEY: undefined }, () =>
      createProvider("minimax", {
        apiKey: "minimax-test",
        model: "MiniMax-M2.5",
      }),
    );
    const github = withEnv({ GITHUB_TOKEN: undefined }, () =>
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

  test("rejects retired provider selectors instead of aliasing them", () => {
    expect(() => createProvider("custom" as ProviderName, {})).toThrow(
      'retired provider selector "custom" is not accepted at provider factory; use "openai-compatible" instead',
    );
    expect(() =>
      createProvider("openai_compatible" as ProviderName, {}),
    ).toThrow('use "openai-compatible" instead');
  });

  test("adds the required OpenRouter routing headers", () => {
    const provider = withEnv({ OPENROUTER_API_KEY: undefined }, () =>
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
    const bare = withEnv({ GITHUB_TOKEN: undefined }, () =>
      createProvider("github", {
        apiKey: "github-test",
        model: "GitHub:Copilot",
      }),
    );
    const compound = withEnv({ GITHUB_TOKEN: undefined }, () =>
      createProvider("github", {
        apiKey: "github-test",
        model: "GitHub:Copilot:gpt-5.4",
      }),
    );

    expect(
      (bare as unknown as { config: OpenAIProviderConfig }).config.model,
    ).toBe("gpt-5.3-codex");
    expect(
      (compound as unknown as { config: OpenAIProviderConfig }).config.model,
    ).toBe("gpt-5.4");
  });

  test("uses the documented openai default model when no model override is supplied", () => {
    const provider = withEnv(
      {
        OPENAI_API_KEY: undefined,
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

  test("preserves Anthropic bearer-token authentication in factory state", () => {
    const provider = createProvider("anthropic", {
      authToken: "anthropic-bearer-token",
      model: "claude-sonnet-4.5",
    });

    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(readProviderFactoryOptions(provider)).toMatchObject({
      authToken: "anthropic-bearer-token",
      model: "claude-sonnet-4.5",
    });
    expect(readProviderFactoryOptions(provider).apiKey).toBeUndefined();
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
      },
      () =>
        createProvider("amazon-bedrock", {
          model: "amazon.nova-lite-v1:0",
          extra: {
            accessKeyId: "aws-access",
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

  test("keeps an explicit Bedrock endpoint ahead of regional derivation", () => {
    const provider = createProvider("amazon-bedrock", {
      baseURL: "https://bedrock-proxy.example/v1",
      model: "amazon.nova-lite-v1:0",
      extra: {
        accessKeyId: "aws-access",
        secretAccessKey: "aws-secret",
        region: "ca-central-1",
      },
    });

    expect(readProviderFactoryOptions(provider)).toMatchObject({
      baseURL: "https://bedrock-proxy.example/v1",
      extra: { region: "ca-central-1" },
    });
  });

  test("rejects the generic apiKey facade for Bedrock", () => {
    expect(() =>
      withEnv(
        {
          AWS_BEDROCK_ACCESS_KEY_ID: undefined,
          AWS_ACCESS_KEY_ID: undefined,
          AWS_BEDROCK_SECRET_ACCESS_KEY: undefined,
          AWS_SECRET_ACCESS_KEY: undefined,
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
      ),
    ).toThrow(
      /amazon-bedrock does not accept the generic apiKey factory option/u,
    );
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
          model: "amazon.nova-pro-v1:0",
          extra: {
            accessKeyId: "configured-access-key",
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
    expect(
      new Headers(init?.headers as HeadersInit).get("x-amz-security-token"),
    ).toBe("configured-session-token");
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

  test("maps resolved providers.ollama.context_window_tokens to the native request", async () => {
    const chat = vi.fn().mockResolvedValue({
      model: "llama3.3",
      message: { role: "assistant", content: "ok" },
      prompt_eval_count: 1,
      eval_count: 1,
    });
    const provider = createProvider("ollama", {
      model: "llama3.3",
      extra: { contextWindowTokens: 131_072 },
    });
    (provider as unknown as { client: unknown }).client = { chat };

    await provider.chat([{ role: "user", content: "hello" }], {
      singleWireAttempt: true,
    });

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ num_ctx: 131_072 }),
      }),
    );
  });

  test.each([
    {
      name: "ollama",
      env: {
        OLLAMA_BASE_URL: undefined,
        OPENAI_BASE_URL: "http://127.0.0.1:9499/v1",
      },
      model: undefined,
      expectedBaseURL: "http://localhost:11434",
      expectedModel: "llama3.3",
    },
    {
      name: "lmstudio",
      env: {
        LMSTUDIO_BASE_URL: undefined,
        OPENAI_API_KEY: "wrong-openai-token",
        OPENAI_BASE_URL: "http://127.0.0.1:9499/v1",
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
        OPENAI_API_KEY: "wrong-openai-token",
        OPENAI_BASE_URL: "http://127.0.0.1:9000/v1",
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
        OPENAI_BASE_URL: "http://127.0.0.1:9499/v1",
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
        OPENAI_BASE_URL: "http://127.0.0.1:9499/v1",
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
        OPENAI_BASE_URL: "http://127.0.0.1:9499/v1",
      },
      apiKey: "deepseek-test",
      model: undefined,
      expectedBaseURL: "https://api.deepseek.com/v1",
      expectedModel: "deepseek-v4-flash",
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
      model: "deepseek-v4-pro",
      expectedBaseURL: "https://api.deepseek.com/v1",
      expectedModel: "deepseek-v4-pro",
      expectedUseResponsesApi: false,
      assertApiKey: true,
      expectedApiKey: "deepseek-test",
    },
    {
      name: "mistral",
      env: {
        MISTRAL_API_KEY: undefined,
        MISTRAL_BASE_URL: undefined,
        OPENAI_BASE_URL: "http://127.0.0.1:19090/v1",
      },
      apiKey: "mistral-test",
      model: undefined,
      expectedBaseURL: "https://api.mistral.ai/v1",
      expectedModel: "mistral-medium-latest",
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
        OPENAI_BASE_URL: "http://127.0.0.1:19090/v1",
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
        OPENAI_BASE_URL: "http://127.0.0.1:19090/v1",
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
        OPENAI_API_KEY: "sk-openai",
        OPENAI_BASE_URL: "http://127.0.0.1:19090/v1",
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
      expectedUseResponsesApi: undefined,
      expectedInstance: GeminiProvider,
      assertApiKey: false,
      expectedApiKey: undefined,
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
        createProvider(
          name,
          resolveProviderFactoryOptions(
            name,
            {
              ...(apiKey !== undefined ? { apiKey } : {}),
              model: model ?? expectedModel,
            },
            process.env,
          ),
        ),
      );
      if (name === "ollama") {
        expect(provider).toBeInstanceOf(OllamaProvider);
        expect(isFactoryProvider(provider)).toBe(true);
        const config = (
          provider as unknown as { config: { host?: string; model: string } }
        ).config;
        expect(config.host).toBe(expectedBaseURL);
        expect(config.model).toBe(expectedModel);
      } else if (name === "gemini") {
        expect(provider).toBeInstanceOf(GeminiProvider);
        expect(isFactoryProvider(provider)).toBe(true);
        const config = (provider as unknown as { config: GeminiProviderConfig })
          .config;
        expect(config.model).toBe(expectedModel);
        expect(config.credentialPlan).toEqual({
          kind: "api-key",
          credential: "gemini-test",
          source: "factory",
        });
        expect(config.endpointPlan).toMatchObject({
          kind: "developer",
          nativeBaseURL: expectedBaseURL,
        });
        expect(config).not.toHaveProperty("apiKey");
        expect(config).not.toHaveProperty("baseURL");
        expect(config).not.toHaveProperty("useResponsesApi");
        const factoryOptions = readProviderFactoryOptions(provider);
        expect(factoryOptions.apiKey).toBeUndefined();
        expect(factoryOptions.baseURL).toBeUndefined();
        expect(factoryOptions.extra).toMatchObject({
          gemini: { endpointPlan: config.endpointPlan },
        });
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
      },
      () =>
        createProvider(
          "gemini",
          resolveProviderFactoryOptions(
            "gemini",
            { model: "gemini-2.5-pro" },
            process.env,
          ),
        ),
    );

    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(readProviderFactoryOptions(provider)).toMatchObject({
      model: "gemini-2.5-pro",
      extra: {
        gemini: {
          credentialPlan: {
            kind: "api-key",
            credential: "google-test",
            source: "GOOGLE_API_KEY",
          },
          endpointPlan: {
            kind: "developer",
            nativeBaseURL: "https://generativelanguage.googleapis.com/v1beta",
          },
        },
      },
    });
    expect(readProviderFactoryOptions(provider).apiKey).toBeUndefined();
    expect(readProviderFactoryOptions(provider).baseURL).toBeUndefined();
  });

  test("does not infer Vertex from ambient project metadata for an API key", () => {
    const options = resolveProviderFactoryOptions(
      "gemini",
      { model: "gemini-2.5-pro" },
      {
        GEMINI_API_KEY: "developer-key",
        GEMINI_PROJECT_ID: "ambient-project",
        GEMINI_VERTEX_LOCATION: "us-central1",
      },
    );

    expect(options.extra).toMatchObject({
      gemini: {
        credentialPlan: {
          kind: "api-key",
          credential: "developer-key",
          source: "GEMINI_API_KEY",
        },
      },
    });
    expect(options.extra).toMatchObject({
      gemini: {
        endpointPlan: {
          kind: "developer",
          nativeBaseURL: "https://generativelanguage.googleapis.com/v1beta",
        },
      },
    });
    const rebuilt = readProviderFactoryOptions(
      createProvider("gemini", options),
    );
    expect(rebuilt.apiKey).toBeUndefined();
    expect(rebuilt.baseURL).toBeUndefined();
    expect(rebuilt.extra).toMatchObject({
      gemini: {
        endpointPlan: { kind: "developer" },
      },
    });
  });

  test("round-trips a directly constructed Gemini provider", () => {
    const direct = new GeminiProvider({
      model: "gemini-2.5-pro",
      credentialPlan: {
        kind: "api-key",
        credential: "direct-key",
        source: "factory",
      },
      endpointPlan: createGeminiEndpointPlan(),
      cachedContent: "cachedContents/direct-context",
    });

    const rebuilt = createProvider(
      "gemini",
      readProviderFactoryOptions(direct),
    ) as GeminiProvider;
    const rebuiltConfig = (
      rebuilt as unknown as { config: GeminiProviderConfig }
    ).config;

    expect(rebuiltConfig.credentialPlan).toEqual({
      kind: "api-key",
      credential: "direct-key",
      source: "factory",
    });
    expect(rebuiltConfig.endpointPlan).toEqual(createGeminiEndpointPlan());
    expect(rebuiltConfig.cachedContent).toBe("cachedContents/direct-context");
    expect(readProviderFactoryOptions(rebuilt).apiKey).toBeUndefined();
    expect(readProviderFactoryOptions(rebuilt).baseURL).toBeUndefined();
  });

  test.each([
    "Authorization",
    "authorization",
    "X-Api-Key",
    "api-key",
    "X-Goog-Api-Key",
    "x-goog-user-project",
  ])("rejects conflicting Gemini default header %s", (header) => {
    expect(
      () =>
        new GeminiProvider({
          model: "gemini-2.5-pro",
          credentialPlan: {
            kind: "api-key",
            credential: "factory-key",
            source: "factory",
          },
          endpointPlan: createGeminiEndpointPlan(),
          defaultHeaders: { [header]: "parallel-credential" },
        }),
    ).toThrow(/cannot override canonical authentication headers/u);
  });

  test("keeps a forced Gemini ADC mode ahead of API keys", () => {
    const resolved = resolveProviderFactoryOptions(
      "gemini",
      { apiKey: "factory-key", model: "gemini-2.5-pro" },
      {
        GEMINI_AUTH_MODE: "adc",
        GOOGLE_API_KEY: "environment-key",
        GOOGLE_APPLICATION_CREDENTIALS: "/missing/adc.json",
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT: "project-1",
      },
    );

    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.extra).toMatchObject({
      gemini: {
        credentialPlan: {
          kind: "none",
          mode: "adc",
          expected: "adc",
          configuredPath: "/missing/adc.json",
        },
        endpointPlan: {
          kind: "vertex",
          project: "project-1",
          location: "us-central1",
        },
      },
    });
  });

  test.each([
    ["accessToken", "token"],
    ["authMode", "oauth"],
    ["oauth", { accessToken: "token" }],
    ["resolveCredential", async () => ({ kind: "none" })],
    ["geminiLocation", "us-central1"],
    ["location", "us-central1"],
    ["project", "project-1"],
    ["cachedContent", "cachedContents/old"],
  ] as const)("rejects retired Gemini extra field %s", (field, value) => {
    expect(() =>
      resolveProviderFactoryOptions(
        "gemini",
        { extra: { [field]: value } },
        { GEMINI_API_KEY: "gemini-key" },
      ),
    ).toThrow(/retired credential\/config fields/u);
    expect(() =>
      createProvider("gemini", {
        model: "gemini-2.5-pro",
        extra: {
          [field]: value,
          gemini: {
            credentialPlan: {
              kind: "api-key",
              credential: "gemini-key",
              source: "factory",
            },
            endpointPlan: createGeminiEndpointPlan(),
          },
        },
      }),
    ).toThrow(/retired credential\/config fields/u);
  });

  test.each([
    [{ apiKey: "parallel-key" }, /does not accept apiKey/u],
    [{ baseURL: "https://parallel.example/v1" }, /does not accept baseURL/u],
  ] as const)(
    "rejects generic Gemini factory authority alongside a canonical plan",
    (parallel, expected) => {
      expect(() =>
        createProvider("gemini", {
          ...parallel,
          model: "gemini-2.5-pro",
          extra: {
            gemini: {
              credentialPlan: {
                kind: "api-key",
                credential: "canonical-key",
                source: "factory",
              },
              endpointPlan: createGeminiEndpointPlan(),
            },
          },
        }),
      ).toThrow(expected);
    },
  );

  test("round-trips independently cloned canonical Gemini runtime options", () => {
    const provider = createProvider(
      "gemini",
      resolveProviderFactoryOptions(
        "gemini",
        { model: "gemini-2.5-pro" },
        { GEMINI_API_KEY: "gemini-key" },
      ),
    );
    const first = readProviderFactoryOptions(provider);
    const second = readProviderFactoryOptions(provider);
    const firstGemini = first.extra?.gemini as Record<string, unknown>;
    const secondGemini = second.extra?.gemini as Record<string, unknown>;

    expect(first.apiKey).toBeUndefined();
    expect(firstGemini).not.toBe(secondGemini);
    expect(firstGemini.credentialPlan).not.toBe(secondGemini.credentialPlan);
    expect(Object.isFrozen(firstGemini)).toBe(true);
    expect(Object.isFrozen(firstGemini.credentialPlan)).toBe(true);
  });

  test("does not reapply ambient endpoint or cache settings to a canonical Gemini plan", () => {
    const canonical = {
      credentialPlan: {
        kind: "api-key" as const,
        credential: "canonical-key",
        source: "factory" as const,
      },
      endpointPlan: createGeminiEndpointPlan(),
    };
    const resolved = resolveProviderFactoryOptions(
      "gemini",
      {
        model: "gemini-2.5-pro",
        extra: { gemini: canonical },
      },
      {
        GEMINI_BASE_URL: "https://ambient.example/v1",
        GEMINI_CACHED_CONTENT: "cachedContents/ambient",
      },
    );

    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.baseURL).toBeUndefined();
    expect(resolved.extra?.gemini).toMatchObject(canonical);
    expect(resolved.extra?.gemini).not.toHaveProperty("cachedContent");
  });

  test("resolves factory credentials and endpoints from the canonical provider rows", () => {
    for (const [provider, definition] of Object.entries(
      BUILT_IN_PROVIDER_DEFINITIONS,
    )) {
      const primaryCredentialEnvVars =
        definition.credentials.kind === "api-key"
          ? definition.credentials.apiKey.envVars
          : [];
      for (const envVar of primaryCredentialEnvVars) {
        const resolved = resolveProviderFactoryOptions(
          provider as ProviderName,
          {},
          { [envVar]: `${provider}-key` },
        );
        if (provider === "gemini") {
          expect(resolved.apiKey, `${provider} ${envVar}`).toBeUndefined();
          expect(resolved.baseURL, `${provider} ${envVar}`).toBeUndefined();
          expect(resolved.extra).toMatchObject({
            gemini: {
              credentialPlan: {
                kind: "api-key",
                credential: `${provider}-key`,
                source: envVar,
              },
              endpointPlan: {
                kind: "developer",
                nativeBaseURL:
                  "https://generativelanguage.googleapis.com/v1beta",
              },
            },
          });
        } else {
          expect(resolved.apiKey, `${provider} ${envVar}`).toBe(
            `${provider}-key`,
          );
        }
      }
      for (const envVar of definition.baseURLEnvVars) {
        const resolved = resolveProviderFactoryOptions(
          provider as ProviderName,
          {},
          { [envVar]: `https://${provider}.example/v1` },
        );
        if (provider === "gemini") {
          expect(resolved.baseURL, `${provider} ${envVar}`).toBeUndefined();
          expect(resolved.extra).toMatchObject({
            gemini: {
              endpointPlan: {
                kind: "custom",
                nativeBaseURL: `https://${provider}.example/v1`,
              },
            },
          });
        } else {
          expect(resolved.baseURL, `${provider} ${envVar}`).toBe(
            `https://${provider}.example/v1`,
          );
        }
      }
    }

    expect(
      resolveProviderFactoryOptions(
        "agenc",
        {},
        {
          AGENC_API_KEY: "managed-auth-not-byok",
        },
      ).apiKey,
    ).toBeUndefined();
  });

  test("resolves every Bedrock SigV4 field through registry alias order", () => {
    const resolved = resolveProviderFactoryOptions(
      "amazon-bedrock",
      {},
      {
        AWS_BEDROCK_ACCESS_KEY_ID: " undefined ",
        AWS_ACCESS_KEY_ID: " fallback-access ",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "undefined",
        AWS_SECRET_ACCESS_KEY: " fallback-secret ",
        AWS_BEDROCK_SESSION_TOKEN: " ",
        AWS_SESSION_TOKEN: " fallback-session ",
        AWS_BEDROCK_REGION: "UNDEFINED",
        AWS_REGION: " fallback-region ",
      },
    );

    expect(resolved).toMatchObject({
      extra: {
        accessKeyId: "fallback-access",
        secretAccessKey: "fallback-secret",
        sessionToken: "fallback-session",
        region: "fallback-region",
      },
    });
  });

  test("keeps explicit Bedrock fields ahead of environment credentials", () => {
    const resolved = resolveProviderFactoryOptions(
      "amazon-bedrock",
      {
        extra: {
          accessKeyId: "explicit-access",
          secretAccessKey: "explicit-secret",
          sessionToken: "explicit-session",
          region: "explicit-region",
        },
      },
      {
        AWS_BEDROCK_ACCESS_KEY_ID: "environment-access",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "environment-secret",
        AWS_BEDROCK_SESSION_TOKEN: "environment-session",
        AWS_BEDROCK_REGION: "environment-region",
      },
    );

    expect(resolved).toMatchObject({
      extra: {
        accessKeyId: "explicit-access",
        secretAccessKey: "explicit-secret",
        sessionToken: "explicit-session",
        region: "explicit-region",
      },
    });
    expect(resolved.apiKey).toBeUndefined();
  });

  test("rejects generic apiKey input before resolving Bedrock options", () => {
    expect(() =>
      resolveProviderFactoryOptions(
        "amazon-bedrock",
        { apiKey: "singular-access-key" },
        {
          AWS_BEDROCK_SECRET_ACCESS_KEY: "environment-secret",
        },
      ),
    ).toThrow(
      /amazon-bedrock does not accept the generic apiKey factory option/u,
    );
  });

  test("infers a canonical Vertex endpoint plan from bearer env credentials", () => {
    const provider = withEnv(
      {
        GOOGLE_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        GEMINI_ACCESS_TOKEN: "ya29-env-token",
        GOOGLE_CLOUD_PROJECT: "project-1",
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GEMINI_VERTEX_LOCATION: undefined,
        GEMINI_BASE_URL: undefined,
      },
      () =>
        createProvider(
          "gemini",
          resolveProviderFactoryOptions(
            "gemini",
            { model: "gemini-2.5-pro" },
            process.env,
          ),
        ),
    );

    expect(provider).toBeInstanceOf(GeminiProvider);
    const config = (
      provider as unknown as {
        config: GeminiProviderConfig;
      }
    ).config;
    expect(config.credentialPlan).toEqual({
      kind: "access-token",
      credential: "ya29-env-token",
      projectId: "project-1",
      source: "GEMINI_ACCESS_TOKEN",
    });
    expect(config.endpointPlan).toEqual({
      kind: "vertex",
      project: "project-1",
      location: "us-central1",
      nativeBaseURL:
        "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google",
    });
    expect(config).not.toHaveProperty("baseURL");
    expect(readProviderFactoryOptions(provider).extra).toMatchObject({
      gemini: {
        endpointPlan: config.endpointPlan,
      },
    });
    expect(readProviderFactoryOptions(provider).baseURL).toBeUndefined();
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
        GEMINI_VERTEX_LOCATION: undefined,
        GEMINI_BASE_URL: undefined,
      },
      () =>
        createProvider(
          "gemini",
          resolveProviderFactoryOptions(
            "gemini",
            { model: "gemini-2.5-pro" },
            process.env,
          ),
        ),
    );

    expect(provider).toBeInstanceOf(GeminiProvider);
    const config = (
      provider as unknown as {
        config: GeminiProviderConfig;
      }
    ).config;
    expect(config.credentialPlan).toEqual({
      kind: "access-token",
      credential: "ya29-env-token",
      projectId: "project-1",
      source: "GEMINI_ACCESS_TOKEN",
    });
    expect(config).not.toHaveProperty("apiKey");
    expect(config).not.toHaveProperty("accessToken");
    expect(config).not.toHaveProperty("project");
    expect(config.endpointPlan).toMatchObject({
      kind: "vertex",
      project: "project-1",
      location: "us-central1",
      nativeBaseURL:
        "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google",
    });
    expect(config).not.toHaveProperty("baseURL");
    expect(readProviderFactoryOptions(provider).baseURL).toBeUndefined();
  });

  test("honors Gemini ADC auth mode even when GOOGLE_API_KEY is present", () => {
    const provider = withEnv(
      {
        GEMINI_AUTH_MODE: "adc",
        GOOGLE_API_KEY: "google-test",
        GEMINI_API_KEY: undefined,
        GEMINI_ACCESS_TOKEN: undefined,
        GOOGLE_APPLICATION_CREDENTIALS: "/missing/gemini-adc.json",
        GOOGLE_CLOUD_PROJECT: "project-1",
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GEMINI_VERTEX_LOCATION: undefined,
        GEMINI_BASE_URL: undefined,
      },
      () =>
        createProvider(
          "gemini",
          resolveProviderFactoryOptions(
            "gemini",
            { model: "gemini-2.5-pro" },
            process.env,
          ),
        ),
    );

    expect(provider).toBeInstanceOf(GeminiProvider);
    const config = (
      provider as unknown as {
        config: GeminiProviderConfig;
      }
    ).config;
    expect(config.credentialPlan).toMatchObject({
      kind: "none",
      mode: "adc",
      expected: "adc",
      configuredPath: "/missing/gemini-adc.json",
    });
    expect(config).not.toHaveProperty("apiKey");
    expect(config).not.toHaveProperty("project");
    expect(config.endpointPlan).toMatchObject({
      kind: "vertex",
      project: "project-1",
      location: "us-central1",
      nativeBaseURL:
        "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google",
    });
    expect(config).not.toHaveProperty("baseURL");
    expect(readProviderFactoryOptions(provider).baseURL).toBeUndefined();
  });

  test.each([
    {
      mode: "access-token",
      env: {
        GEMINI_AUTH_MODE: "access-token",
        GEMINI_ACCESS_TOKEN: "forced-access-token",
        GOOGLE_API_KEY: "ignored-api-key",
      },
    },
    {
      mode: "adc",
      env: {
        GEMINI_AUTH_MODE: "adc",
        GOOGLE_APPLICATION_CREDENTIALS: "/missing/gemini-adc.json",
        GOOGLE_API_KEY: "ignored-api-key",
      },
    },
  ] as const)(
    "fails closed when forced Gemini $mode routing lacks project/location",
    ({ env }) => {
      expect(() =>
        resolveProviderFactoryOptions(
          "gemini",
          { model: "gemini-2.5-pro" },
          env,
        ),
      ).toThrow(
        /access-token\/ADC routing requires both project and location/u,
      );
    },
  );

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
      },
      expected: /OPENROUTER_API_KEY|apiKey/i,
    },
    {
      name: "groq",
      env: {
        OPENAI_API_KEY: "sk-openai",
        GROQ_API_KEY: undefined,
      },
      expected: /GROQ_API_KEY|apiKey/i,
    },
    {
      name: "deepseek",
      env: {
        OPENAI_API_KEY: "sk-openai",
        DEEPSEEK_API_KEY: undefined,
      },
      expected: /DEEPSEEK_API_KEY|apiKey/i,
    },
    {
      name: "mistral",
      env: {
        OPENAI_API_KEY: "sk-openai",
        MISTRAL_API_KEY: undefined,
      },
      expected: /MISTRAL_API_KEY|apiKey/i,
    },
    {
      name: "nvidia-nim",
      env: {
        OPENAI_API_KEY: "sk-openai",
        NVIDIA_API_KEY: undefined,
      },
      expected: /NVIDIA_API_KEY|apiKey/i,
    },
    {
      name: "minimax",
      env: {
        OPENAI_API_KEY: "sk-openai",
        MINIMAX_API_KEY: undefined,
      },
      expected: /MINIMAX_API_KEY|apiKey/i,
    },
    {
      name: "github",
      env: {
        OPENAI_API_KEY: "sk-openai",
        GITHUB_TOKEN: undefined,
        GH_TOKEN: undefined,
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
        expect(() => createProvider("grok", { model: "grok-4.3" })).toThrow(
          /XAI_API_KEY|apiKey/i,
        );
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

    expect(readProviderFactoryOptions(provider).model).toBe("grok-4.6");
  });

  test("'openai' without apiKey throws explanatory error", () => {
    withEnv(
      {
        OPENAI_API_KEY: undefined,
      },
      () => {
        expect(() => createProvider("openai", { model: "gpt-5.4" })).toThrow(
          /OPENAI_API_KEY|apiKey/i,
        );
      },
    );
  });

  test("'openrouter' uses the registry default model without an override", () => {
    const provider = withEnv(
      {
        OPENROUTER_API_KEY: undefined,
      },
      () => createProvider("openrouter", { apiKey: "or-test" }),
    );

    expect(readProviderFactoryOptions(provider).model).toBe("x-ai/grok-4.5");
  });

  test("'lmstudio' uses the registry default model without an override", () => {
    const provider = createProvider("lmstudio", {});

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
