import { describe, expect, test, vi } from "vitest";
import { resolveHomeContext } from "../../src/config/home.js";
import { resolveProviderFactoryOptions } from "../../src/llm/provider-options.js";
import { createProvider } from "../../src/llm/provider.js";
import { resolveProviderRuntimeRequest } from "../../src/llm/provider-request.js";
import { resolveBuiltInProviderSlug } from "../../src/llm/registry/provider-info.js";
import { defaultConfig } from "../../src/config/schema.js";
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
  test("preview selects saved BYOK over eligible managed billing", async () => {
    const readSavedApiKey = vi.fn(async (provider: string) => provider === "deepseek" ? "saved-deepseek-key" : undefined);
    const authBackend = { kind: "local" as const, vendKey: vi.fn() } as never;
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent-key" }),
      readSavedApiKey, authBackend, sessionId: "signed-in-session", subscriptionTier: "pro",
      resolvePreparationRequest: ({ model }) => ({ requested: { model }, runtime: { managedKeysEnabled: true } }),
    });
    const selection = { provider: "deepseek", model: "deepseek-v4-pro" };
    const preview = await service.previewChildDestination(selection);
    expect(preview).toMatchObject({ authProfile: "api_key", billingSource: "byok" });
    expect(authBackend.vendKey).not.toHaveBeenCalled();
    const prepared = await service.prepareChild(selection);
    expect(prepared).toMatchObject({ authProfile: preview.authProfile, billingSource: preview.billingSource });
    expect(prepared.binding.factoryOptions.apiKey).toBe("saved-deepseek-key");
    await prepared.binding.instance.dispose?.();
  });

  test("preview applies the same managed entitlement decision as preparation", async () => {
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent-key" }),
      environment: {},
      authBackend: { kind: "remote" } as never,
      sessionId: "signed-in-session", subscriptionTier: "free",
      resolvePreparationRequest: ({ model }) => ({ requested: { model }, runtime: { managedKeysEnabled: true } }),
    });
    const selection = { provider: "openrouter", model: "openai/gpt-5" };
    await expect(service.previewChildDestination(selection)).rejects.toThrow(/active AgenC subscription/u);
    await expect(service.prepareChild(selection)).rejects.toThrow(/active AgenC subscription/u);
  });

  test.each([
    {
      label: "captured environment",
      environment: { DEEPSEEK_BASE_URL: "https://receiver.example/v1" },
      providers: undefined,
      source: "DEEPSEEK_BASE_URL",
    },
    {
      label: "provider config",
      environment: {},
      providers: { deepseek: { base_url: "https://receiver.example/v1" } },
      source: "providers.deepseek.base_url",
    },
  ])("rejects a cross-provider child's custom endpoint from $label before credentials", async ({ environment, providers, source }) => {
    const readSavedApiKey = vi.fn(async () => "secret");
    const config = { ...defaultConfig(), ...(providers ? { providers } : {}) };
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent-key" }),
      environment,
      readSavedApiKey,
      resolvePreparationRequest: ({ provider, model }) => ({
        requested: resolveProviderRuntimeRequest({
          provider: resolveBuiltInProviderSlug(provider)!, model, config,
          environment: service.environment(),
        }).requested,
      }),
    });
    await expect(service.prepareChild({ provider: "deepseek", model: "deepseek-v4-pro" }))
      .rejects.toThrow(source);
    expect(readSavedApiKey).not.toHaveBeenCalled();
  });

  test("accepts a canonical cross-provider endpoint and preserves same-provider custom endpoints", async () => {
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent-key" }),
      environment: { DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1" },
      readSavedApiKey: async () => "target-key",
      resolvePreparationRequest: ({ model }) => ({ requested: { model } }),
    });
    const cross = await service.prepareChild({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(cross.binding.factoryOptions.baseURL).toBe("https://api.deepseek.com/v1");
    expect(cross.binding.factoryOptions.apiKey).toBe("target-key");
    await cross.binding.instance.dispose?.();

    const child = service.forkForChild(createProvider("deepseek", {
      model: "deepseek-v4-pro", apiKey: "target-key", baseURL: "https://receiver.example/v1",
    }), { provider: "deepseek", model: "deepseek-v4-pro" });
    const local = await child.prepareChild({ provider: "deepseek", model: "deepseek-flash" }, {
      model: "deepseek-flash", baseURL: "https://receiver.example/v1",
    });
    expect(local.binding.factoryOptions.baseURL).toBe("https://receiver.example/v1");
    await local.binding.instance.dispose?.();
  });

  test("restart pins a cross-provider child after its parent switches to the child's provider", async () => {
    const readSavedApiKey = vi.fn(async () => "child-secret");
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent-key" }),
      readSavedApiKey,
      resolvePreparationRequest: ({ model }) => ({
        requested: { model, baseURL: "https://receiver.example/v1" },
      }),
    });
    const switched = await service.prepare(
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { model: "deepseek-v4-pro", apiKey: "parent-key", baseURL: "https://receiver.example/v1" },
    );
    service.commit(switched);
    await expect(service.prepareChild(
      { provider: "deepseek", model: "deepseek-v4-pro" },
      undefined,
      {},
      true,
    )).rejects.toThrow(/default endpoint/u);
    expect(readSavedApiKey).not.toHaveBeenCalled();
    await switched.binding.instance.dispose?.();
  });

  test("a cross-provider child's later provider switch retains its endpoint pin", async () => {
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent" }),
      environment: { DEEPSEEK_API_KEY: "child-key" },
    });
    const prepared = await service.prepareChild(
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { model: "deepseek-v4-pro" },
    );
    const child = service.forkForChild(prepared.binding.instance, {
      provider: "deepseek", model: "deepseek-v4-pro",
    });
    await expect(child.prepare(
      { provider: "deepseek", model: "deepseek-flash" },
      { model: "deepseek-flash", baseURL: "https://receiver.example/v1" },
    )).rejects.toThrow(/default endpoint/u);
  });

  test("a bound cross-provider child refuses a provider or model switch", async () => {
    const service = new SessionProviderService({
      initialProvider: createProvider("deepseek", { model: "deepseek-v4-pro", apiKey: "child-key" }),
      destinationLock: { provider: "deepseek", model: "deepseek-v4-pro" },
    });
    await expect(service.prepare({ provider: "openai", model: "gpt-5.4" }, { apiKey: "other-key" }))
      .rejects.toThrow(/new execution plan/u);
    await expect(service.prepare({ provider: "deepseek", model: "deepseek-flash" }, { apiKey: "child-key" }))
      .rejects.toThrow(/new execution plan/u);
  });

  test("managed child refuses a vended noncanonical endpoint before sending its key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => completion("unexpected"));
    const vendKey = vi.fn((provider: string, sessionId: string) => ({
      kind: "api-key" as const, provider, sessionId, apiKey: "vended-secret",
      baseUrl: "https://receiver.example/v1",
    }));
    const authBackend = {
      kind: "local" as const,
      login: vi.fn(), logout: vi.fn(), whoami: vi.fn(), vendKey,
      inferAgencModel: vi.fn(), getLlmUsage: vi.fn(), getSubscriptionTier: vi.fn(),
    };
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent-key" }),
      authBackend,
      sessionId: "child-session",
      subscriptionTier: "pro",
    });
    const prepared = await service.prepareChild(
      { provider: "openrouter", model: "x-ai/grok-4.5" },
      { model: "x-ai/grok-4.5", extra: { fetchImpl } },
      { managedKeysEnabled: true },
      true,
    );
    await expect(prepared.binding.instance.chat([{ role: "user", content: "hello" }]))
      .rejects.toThrow(/vended.*endpoint|default endpoint/u);
    expect(vendKey).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    await prepared.binding.instance.dispose?.();
  });

  test("AgenC child refuses a noncanonical concrete endpoint from vending", async () => {
    const wire = vi.fn<typeof fetch>(async () => completion("unexpected"));
    const authBackend = {
      kind: "local" as const,
      login: vi.fn(), logout: vi.fn(), whoami: vi.fn(),
      vendKey: vi.fn(async (provider: string, sessionId: string) => ({
        kind: "api-key" as const, provider, sessionId,
        apiKey: "vended-secret", baseUrl: "https://receiver.example/v1",
      })),
      inferAgencModel: vi.fn(async () => ({ provider: "deepseek", model: "deepseek-v4-pro" })),
      getLlmUsage: vi.fn(), getSubscriptionTier: vi.fn(),
    };
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent" }),
      authBackend,
      sessionId: "child-session",
    });
    const prepared = await service.prepareChild(
      { provider: "agenc", model: "deepseek-v4-pro" },
      { model: "deepseek-v4-pro", extra: { fetchImpl: wire } },
      { managedKeysEnabled: true },
      true,
      { provider: "deepseek", model: "deepseek-v4-pro" },
    );
    await expect(prepared.binding.instance.chat([{ role: "user", content: "hello" }]))
      .rejects.toThrow(/endpoint|refused/u);
    expect(authBackend.vendKey).toHaveBeenCalledOnce();
    expect(wire).not.toHaveBeenCalled();
  });

  test("managed child refuses a different inferred concrete provider before vending or sending data", async () => {
    const wire = vi.fn<typeof fetch>(async () => completion("unexpected"));
    const authBackend = {
      kind: "local" as const,
      login: vi.fn(), logout: vi.fn(), whoami: vi.fn(),
      vendKey: vi.fn(async (provider: string, sessionId: string) => ({
        kind: "api-key" as const, provider, sessionId, apiKey: "vended-secret",
      })),
      inferAgencModel: vi.fn(async () => ({ provider: "deepseek", model: "deepseek-v4-pro" })),
      getLlmUsage: vi.fn(), getSubscriptionTier: vi.fn(),
    };
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent" }),
      authBackend, sessionId: "child-session",
    });
    const prepared = await service.prepareChild(
      { provider: "agenc", model: "agenc" },
      { model: "agenc", extra: { fetchImpl: wire } },
      { managedKeysEnabled: true }, true,
      { provider: "openai", model: "gpt-5.4" },
    );
    await expect(prepared.binding.instance.chat([{ role: "user", content: "private task" }]))
      .rejects.toThrow(/destination changed/u);
    expect(authBackend.vendKey).not.toHaveBeenCalled();
    expect(wire).not.toHaveBeenCalled();
    await prepared.binding.instance.dispose?.();
  });

  test("Gemini implicit Vertex routing is refused after credentials resolve", async () => {
    const wire = vi.fn<typeof fetch>(async () => completion("unexpected"));
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent" }),
      environment: {
        GEMINI_ACCESS_TOKEN: "vertex-secret",
        GOOGLE_CLOUD_PROJECT: "gemini-project",
        GOOGLE_CLOUD_LOCATION: "us-central1",
      },
    });
    await expect(service.prepareChild(
      { provider: "gemini", model: "gemini-2.5-pro" },
      { model: "gemini-2.5-pro", extra: { fetchImpl: wire } },
    )).rejects.toThrow(/endpoint|Vertex/u);
    expect(wire).not.toHaveBeenCalled();
  });

  test("rejects a direct child factory endpoint override before reading a saved key", async () => {
    const readSavedApiKey = vi.fn(async () => "secret");
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent-key" }),
      readSavedApiKey,
    });
    await expect(service.prepareChild(
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { model: "deepseek-v4-pro", baseURL: "https://receiver.example/v1" },
    )).rejects.toThrow(/provider factory option/u);
    expect(readSavedApiKey).not.toHaveBeenCalled();
  });

  test.each([
    { provider: "amazon-bedrock", environment: { AWS_REGION: "eu-west-1" }, source: "AWS_REGION" },
    { provider: "gemini", environment: { GEMINI_AUTH_MODE: "access-token" }, source: "GEMINI_AUTH_MODE" },
  ])("rejects $provider alternate endpoint routing before credentials", async ({ provider, environment, source }) => {
    const readSavedApiKey = vi.fn(async () => "secret");
    const service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent-key" }),
      environment,
      readSavedApiKey,
    });
    await expect(service.prepareChild(
      { provider, model: "target-model" }, { model: "target-model" },
    )).rejects.toThrow(source);
    expect(readSavedApiKey).not.toHaveBeenCalled();
  });
  test("forked child and nested child resolve target credentials and endpoint from captured authority", async () => {
    const mutableEnvironment: Record<string, string> = {
      DEEPSEEK_BASE_URL: "https://target.example.test/v1",
    };
    let savedKey: string | undefined = "target-saved-key";
    let service!: SessionProviderService;
    service = new SessionProviderService({
      initialProvider: createProvider("openai", { model: "gpt-5.4", apiKey: "parent-only-key" }),
      environment: mutableEnvironment,
      readSavedApiKey: async (provider) => provider === "deepseek" ? savedKey : undefined,
      resolvePreparationRequest: ({ provider, model }) => {
        const canonical = resolveBuiltInProviderSlug(provider);
        if (canonical === undefined) throw new Error("unknown provider");
        return { requested: resolveProviderRuntimeRequest({
          provider: canonical,
          model,
          config: { model_provider: "openai", model: "gpt-5.4" },
          environment: service.environment(),
        }).requested };
      },
    });
    mutableEnvironment.DEEPSEEK_BASE_URL = "https://mutated.example.test/v1";
    mutableEnvironment.DEEPSEEK_API_KEY = "ambient-after-capture";
    const first = await service.prepare({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(first.binding.factoryOptions).toMatchObject({
      model: "deepseek-v4-pro",
      apiKey: "target-saved-key",
      baseURL: "https://target.example.test/v1",
    });
    expect(JSON.stringify(first.binding.factoryOptions)).not.toContain("parent-only-key");
    expect(service.current()).toMatchObject({ provider: "openai", model: "gpt-5.4" });
    const child = service.forkForChild(first.binding.instance, { provider: "deepseek", model: "deepseek-v4-pro" });
    const nested = await child.prepare({ provider: "deepseek", model: "deepseek-flash" });
    expect(nested.binding.factoryOptions.apiKey).toBe("target-saved-key");
    savedKey = undefined;
    await expect(child.prepare({ provider: "deepseek", model: "deepseek-flash" }))
      .rejects.toThrow(/credential|DEEPSEEK_API_KEY/u);
    await nested.binding.instance.dispose?.();
    await first.binding.instance.dispose?.();
  });
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
