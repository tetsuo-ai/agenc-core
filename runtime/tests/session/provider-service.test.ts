import { describe, expect, test, vi } from "vitest";
import { resolveHomeContext } from "../../src/config/home.js";
import { resolveProviderFactoryOptions } from "../../src/llm/provider-options.js";
import { createProvider } from "../../src/llm/provider.js";
import {
  clearCurrentRuntimeSession,
  runWithCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "../../src/session/current-session.js";
import {
  SessionProviderService,
  bindingFromProvider,
} from "../../src/session/provider-service.js";
import type { Session } from "../../src/session/session.js";
import {
  getAPIProvider,
  getSelectedProviderEnvironment,
  getSelectedProviderModel,
  runWithStartupProviderSelection,
} from "../../src/utils/model/providers.js";

function initialProvider(model: string) {
  return createProvider("openai-compatible", {
    model,
    baseURL: "http://127.0.0.1:18000/v1",
  });
}

function completion(label: string): Response {
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${label}`,
      model: `model-${label}`,
      choices: [
        {
          message: { role: "assistant", content: label },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("SessionProviderService", () => {
  test("fails closed when a provider has no identity or prepared model", () => {
    const anonymous = Object.freeze({ name: "" });
    expect(() =>
      bindingFromProvider({
        provider: anonymous as never,
        model: "model-a",
      })
    ).toThrow("provider binding requires an explicit provider identity");

    const modelLess = Object.freeze({ name: "openai-compatible" });
    expect(() =>
      bindingFromProvider({
        provider: modelLess as never,
      })
    ).toThrow(
      "openai-compatible provider binding requires an explicit model",
    );
  });

  test("rejects an initial provider identity that contradicts its factory", () => {
    const provider = initialProvider("factory-model");

    expect(() =>
      new SessionProviderService({
        initialProvider: provider,
        initialProviderName: "github",
      })
    ).toThrow(
      'provider binding identity conflict: factory is "openai-compatible" but explicit provider is "github"',
    );
  });

  test("rejects an initial model that contradicts its factory", () => {
    const provider = initialProvider("factory-model");
    expect(() =>
      new SessionProviderService({
        initialProvider: provider,
        initialModel: "explicit-model",
      })
    ).toThrow(
      'openai-compatible provider binding model conflict: factory is "factory-model" but explicit model is "explicit-model"',
    );
  });

  test("accepts an injected custom provider identity", () => {
    const custom = Object.freeze({
      name: "custom-provider",
      config: { model: "custom-model" },
    });
    const service = new SessionProviderService({
      initialProvider: custom as never,
    });

    expect(service.current()).toMatchObject({
      provider: "custom-provider",
      model: "custom-model",
      instance: custom,
    });
  });

  test("keeps explicit provider identity separate from an unmarked transport", () => {
    const transport = Object.freeze({
      name: "openai",
      config: { model: "transport-model" },
    });

    expect(
      bindingFromProvider({
        provider: transport as never,
        providerName: "github",
      }).provider,
    ).toBe("github");
  });

  test("deeply snapshots nested factory options in the session binding", () => {
    const defaultHeaders = { "x-bound": "first" };
    const openAiCompatibility = { authHeader: "X-First-Auth" };
    const service = new SessionProviderService({
      initialProvider: createProvider("openai-compatible", {
        model: "bound-model",
        baseURL: "https://bound.example/v1",
        extra: { defaultHeaders, openAiCompatibility },
      }),
    });

    defaultHeaders["x-bound"] = "second";
    openAiCompatibility.authHeader = "X-Second-Auth";

    expect(service.current().factoryOptions.extra?.defaultHeaders).toEqual({
      "x-bound": "first",
    });
    expect(
      service.current().factoryOptions.extra?.openAiCompatibility,
    ).toEqual({ authHeader: "X-First-Auth" });
    expect(
      Object.isFrozen(service.current().factoryOptions.extra?.defaultHeaders),
    ).toBe(true);
    expect(
      Object.isFrozen(
        service.current().factoryOptions.extra?.openAiCompatibility,
      ),
    ).toBe(true);
  });

  test("retains the explicit credential home in every provider binding", async () => {
    const home = resolveHomeContext(
      { AGENC_HOME: "/tmp/agenc-provider-home-a" },
      { platformHome: "/tmp" },
    );
    const service = new SessionProviderService({
      initialProvider: createProvider("openai-compatible", {
        credentialHome: home,
        model: "initial",
        baseURL: "http://127.0.0.1:18000/v1",
      }),
    });

    expect(service.current().factoryOptions.credentialHome).toBe(home);
    const prepared = await service.prepare(
      { provider: "openai-compatible", model: "next" },
      { credentialHome: home },
    );
    expect(prepared.binding.factoryOptions.credentialHome).toBe(home);
  });

  test("projects model API consumers from the async session binding", async () => {
    const previous = process.env.AGENC_PROVIDER;
    process.env.AGENC_PROVIDER = "anthropic";
    try {
      const github = new SessionProviderService({
        initialProvider: createProvider("github", {
          apiKey: "github-test",
          model: "gpt-4o",
        }),
      });
      const openai = new SessionProviderService({
        initialProvider: createProvider("openai", {
          apiKey: "openai-test",
          model: "gpt-5",
        }),
      });
      const githubSession = {
        services: { providerService: github },
      } as unknown as Session;
      const openaiSession = {
        services: { providerService: openai },
      } as unknown as Session;

      const [githubResult, openaiResult] = await Promise.all([
        runWithCurrentRuntimeSession(githubSession, async () => {
          await Promise.resolve();
          return getAPIProvider();
        }),
        runWithCurrentRuntimeSession(openaiSession, async () => {
          await Promise.resolve();
          return getAPIProvider();
        }),
      ]);

      expect(githubResult).toBe("github");
      expect(openaiResult).toBe("openai");
    } finally {
      if (previous === undefined) delete process.env.AGENC_PROVIDER;
      else process.env.AGENC_PROVIDER = previous;
    }
  });

  test("keeps concurrent sessions on their own endpoint, credential, and model", async () => {
    const fetchA = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://provider-a.example/v1/chat/completions",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer key-a",
      );
      return completion("a");
    });
    const fetchB = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://provider-b.example/v1/chat/completions",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer key-b",
      );
      return completion("b");
    });
    const serviceA = new SessionProviderService({
      initialProvider: initialProvider("initial-a"),
      environment: {
        OPENAI_COMPATIBLE_API_KEY: "key-a",
        OPENAI_COMPATIBLE_BASE_URL: "https://provider-a.example/v1",
      },
    });
    const serviceB = new SessionProviderService({
      initialProvider: initialProvider("initial-b"),
      environment: {
        OPENAI_COMPATIBLE_API_KEY: "key-b",
        OPENAI_COMPATIBLE_BASE_URL: "https://provider-b.example/v1",
      },
    });

    serviceA.commit(
      await serviceA.prepare(
        { provider: "openai-compatible", model: "model-a" },
        { extra: { fetchImpl: fetchA } },
      ),
    );
    serviceB.commit(
      await serviceB.prepare(
        { provider: "openai-compatible", model: "model-b" },
        { extra: { fetchImpl: fetchB } },
      ),
    );

    const [a, b] = await Promise.all([
      serviceA.current().instance.chat([{ role: "user", content: "a" }]),
      serviceB.current().instance.chat([{ role: "user", content: "b" }]),
    ]);
    expect(a.content).toBe("a");
    expect(b.content).toBe("b");
    expect(serviceA.current()).toMatchObject({
      provider: "openai-compatible",
      model: "model-a",
      factoryOptions: {
        apiKey: "key-a",
        baseURL: "https://provider-a.example/v1",
      },
    });
    expect(serviceB.current()).toMatchObject({
      provider: "openai-compatible",
      model: "model-b",
      factoryOptions: {
        apiKey: "key-b",
        baseURL: "https://provider-b.example/v1",
      },
    });
  });

  test("never falls back to startup provider authority when live sessions are ambiguous", () => {
    const serviceA = new SessionProviderService({
      initialProvider: initialProvider("model-a"),
      environment: { OPENAI_COMPATIBLE_API_KEY: "key-a" },
    });
    const serviceB = new SessionProviderService({
      initialProvider: initialProvider("model-b"),
      environment: { OPENAI_COMPATIBLE_API_KEY: "key-b" },
    });
    const sessionA = {
      services: { providerService: serviceA },
    } as unknown as Session;
    const sessionB = {
      services: { providerService: serviceB },
    } as unknown as Session;

    setCurrentRuntimeSession(sessionA);
    setCurrentRuntimeSession(sessionB);
    try {
      runWithStartupProviderSelection(
        { provider: "grok", model: "startup-model", environment: {} },
        () => {
          expect(() => getSelectedProviderModel()).toThrow(
            /Ambiguous runtime session/,
          );
          expect(
            runWithCurrentRuntimeSession(sessionA, () => ({
              model: getSelectedProviderModel(),
              key: getSelectedProviderEnvironment().OPENAI_COMPATIBLE_API_KEY,
            })),
          ).toEqual({ model: "model-a", key: "key-a" });
          expect(
            runWithCurrentRuntimeSession(sessionB, () => ({
              model: getSelectedProviderModel(),
              key: getSelectedProviderEnvironment().OPENAI_COMPATIBLE_API_KEY,
            })),
          ).toEqual({ model: "model-b", key: "key-b" });
        },
      );
    } finally {
      clearCurrentRuntimeSession();
    }
  });

  test("post-bootstrap process env mutation cannot change the session provider", async () => {
    const previous = process.env.AGENC_PROVIDER;
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", {
        apiKey: "openai-test",
        model: "gpt-5",
      }),
    });
    const session = {
      services: { providerService: service },
    } as unknown as Session;

    try {
      await runWithCurrentRuntimeSession(session, async () => {
        expect(getAPIProvider()).toBe("openai");
        process.env.AGENC_PROVIDER = "github";
        await Promise.resolve();
        expect(getAPIProvider()).toBe("openai");
        process.env.AGENC_PROVIDER = "anthropic";
        await Promise.resolve();
        expect(getAPIProvider()).toBe("openai");
      });
    } finally {
      if (previous === undefined) delete process.env.AGENC_PROVIDER;
      else process.env.AGENC_PROVIDER = previous;
    }
  });

  test("credentials never change an explicit provider selection", async () => {
    const service = new SessionProviderService({
      initialProvider: initialProvider("initial"),
      environment: { MINIMAX_API_KEY: "minimax-only-key" },
    });
    const prepared = await service.prepare(
      { provider: "openai-compatible", model: "local-model" },
      {},
    );
    expect(prepared.binding.provider).toBe("openai-compatible");
    expect(prepared.binding.factoryOptions.apiKey).toBeUndefined();
  });

  test("rejects a forced Gemini ADC mode before an API key can bypass it", async () => {
    const service = new SessionProviderService({
      initialProvider: createProvider(
        "gemini",
        resolveProviderFactoryOptions(
          "gemini",
          { apiKey: "initial-key", model: "gemini-2.5-pro" },
          {},
        ),
      ),
      environment: {
        GEMINI_AUTH_MODE: "adc",
        GEMINI_VERTEX_LOCATION: "us-central1",
        GEMINI_PROJECT_ID: "session-project",
        GOOGLE_API_KEY: "ambient-key",
        GOOGLE_APPLICATION_CREDENTIALS: "/missing/session-adc.json",
      },
    });

    await expect(
      service.prepare(
        { provider: "gemini", model: "gemini-2.5-flash" },
        {},
      ),
    ).rejects.toThrow(/ADC file \/missing\/session-adc\.json/u);
    await expect(
      service.prepare(
        { provider: "gemini", model: "gemini-2.5-flash" },
        { apiKey: "explicit-key" },
      ),
    ).rejects.toThrow(/ADC file \/missing\/session-adc\.json/u);
  });

  test("recomputes switch-away and back from the canonical request", async () => {
    const resolvePreparationRequest = vi.fn(
      async ({ provider }: { provider: string; model: string }) =>
        provider === "gemini"
          ? { requested: { apiKey: "fresh-key" } }
          : {
              requested: {
                baseURL: "http://127.0.0.1:18000/v1",
              },
            },
    );
    const service = new SessionProviderService({
      initialProvider: createProvider(
        "gemini",
        resolveProviderFactoryOptions(
          "gemini",
          { model: "gemini-2.5-pro" },
          {},
          { savedApiKey: "saved-key" },
        ),
      ),
      resolvePreparationRequest,
    });

    const away = await service.prepare(
      { provider: "openai-compatible", model: "local-model" },
    );
    service.commit(away);
    const back = await service.prepare(
      { provider: "gemini", model: "gemini-2.5-flash" },
    );
    expect(back.binding.factoryOptions).toMatchObject({
      extra: {
        gemini: {
          credentialPlan: {
            kind: "api-key",
            credential: "fresh-key",
            source: "factory",
          },
        },
      },
    });
    expect(resolvePreparationRequest).toHaveBeenCalledTimes(2);
  });

  test("lazily consumes secure-storage-only BYOK on the first Ollama to Gemini switch", async () => {
    const readSavedApiKey = vi.fn(async (provider: string) =>
      provider === "gemini" ? "saved-gemini-key" : undefined,
    );
    const service = new SessionProviderService({
      initialProvider: createProvider("ollama", {
        baseURL: "http://127.0.0.1:11434",
        model: "llama3.3",
      }),
      readSavedApiKey,
    });

    expect(readSavedApiKey).not.toHaveBeenCalled();
    const prepared = await service.prepare(
      { provider: "gemini", model: "gemini-2.5-pro" },
      {},
    );

    expect(readSavedApiKey).toHaveBeenCalledOnce();
    expect(readSavedApiKey).toHaveBeenCalledWith("gemini");
    expect(prepared.binding.factoryOptions).toMatchObject({
      model: "gemini-2.5-pro",
      extra: {
        gemini: {
          credentialPlan: {
            kind: "api-key",
            credential: "saved-gemini-key",
            source: "saved-byok",
          },
        },
      },
    });
    expect(prepared.binding.factoryOptions.apiKey).toBeUndefined();
  });

  test("captures the switch revision before an asynchronous secure-storage read", async () => {
    let releaseSecureStorageRead: (() => void) | undefined;
    const secureStorageReadBlocked = new Promise<void>((resolve) => {
      releaseSecureStorageRead = resolve;
    });
    const readSavedApiKey = vi.fn(async () => {
      await secureStorageReadBlocked;
      return "saved-gemini-key";
    });
    const service = new SessionProviderService({
      initialProvider: initialProvider("initial"),
      readSavedApiKey,
    });

    const pendingGemini = service.prepare(
      { provider: "gemini", model: "gemini-2.5-pro" },
      {},
    );
    await vi.waitFor(() => expect(readSavedApiKey).toHaveBeenCalledOnce());
    const replacement = await service.prepare(
      { provider: "openai-compatible", model: "replacement" },
      {},
    );
    service.commit(replacement);
    releaseSecureStorageRead?.();

    const staleGemini = await pendingGemini;
    expect(() => service.commit(staleGemini)).toThrow(
      /changed while.*prepared/i,
    );
    expect(service.current().model).toBe("replacement");
  });

  test("fails closed when two switches were prepared from the same revision", async () => {
    const service = new SessionProviderService({
      initialProvider: initialProvider("initial"),
    });
    const first = await service.prepare(
      { provider: "openai-compatible", model: "first" },
      {},
    );
    const stale = await service.prepare(
      { provider: "openai-compatible", model: "stale" },
      {},
    );
    service.commit(first);
    expect(() => service.commit(stale)).toThrow(/changed while.*prepared/i);
    expect(service.current().model).toBe("first");
  });

  test("does not mutate the current binding when commit validation fails", async () => {
    const service = new SessionProviderService({
      initialProvider: initialProvider("initial"),
    });
    const before = service.current();
    const prepared = await service.prepare(
      { provider: "openai-compatible", model: "replacement" },
      {},
    );

    expect(() =>
      service.commit({
        ...prepared,
        binding: {
          ...prepared.binding,
          provider: "unknown-provider",
        },
      })
    ).toThrow('unknown bound provider "unknown-provider"');
    expect(service.current()).toBe(before);
  });

  test("restores a failed commit with a new revision that invalidates stale work", async () => {
    const service = new SessionProviderService({
      initialProvider: initialProvider("initial"),
    });
    const before = service.current();
    const stale = await service.prepare(
      { provider: "openai-compatible", model: "stale" },
      {},
    );
    const committed = await service.prepare(
      { provider: "openai-compatible", model: "replacement" },
      {},
    );
    service.commit(committed);

    const restored = service.restoreAfterFailedCommit(
      committed.binding,
      before,
    );

    expect(restored).toMatchObject({
      provider: before.provider,
      model: before.model,
      instance: before.instance,
      factoryOptions: before.factoryOptions,
      revision: committed.binding.revision + 1,
    });
    expect(() => service.commit(stale)).toThrow(/changed while.*prepared/i);
  });

  test("never overwrites a newer provider revision during rollback", async () => {
    const service = new SessionProviderService({
      initialProvider: initialProvider("initial"),
    });
    const before = service.current();
    const first = await service.prepare(
      { provider: "openai-compatible", model: "first" },
      {},
    );
    service.commit(first);
    const newer = await service.prepare(
      { provider: "openai-compatible", model: "newer" },
      {},
    );
    service.commit(newer);

    expect(() =>
      service.restoreAfterFailedCommit(first.binding, before),
    ).toThrow("live binding changed after commit");
    expect(service.current()).toBe(newer.binding);
  });
});
