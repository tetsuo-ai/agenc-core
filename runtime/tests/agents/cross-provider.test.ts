import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/schema.js";
import { assertChildExecutionPlan, assertPreparedChildMatchesPlan, authorizeChildExecutionPlan, childModelInfo, createChildExecutionPlan, resolveChildSelection } from "../../src/agents/cross-provider.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";
import type { Session } from "../../src/session/session.js";

function sessionWithModels(provider: string, model: string, liveModels: string[], configOverrides: Record<string, unknown> = {}): Session {
  const config = {
    ...defaultConfig(),
    model_provider: provider,
    model,
    agents: { cross_provider_enabled: true, allowed_providers: ["openrouter", "deepseek"] },
    ...configOverrides,
  };
  return {
    modelInfo: { slug: model },
    sessionConfiguration: { collaborationMode: { model } },
    providerService: { current: () => ({ provider, model }) },
    services: {
      configStore: { current: () => config },
      modelsManager: {
        tryListModels: () => liveModels.map((slug) => ({ slug })),
        listModels: async () => liveModels.map((slug) => ({ slug })),
      },
    },
  } as unknown as Session;
}

describe("child provider selection", () => {
  it("does not reuse a different same-provider model's instructions without a model catalog", async () => {
    const session = sessionWithModels("grok", "grok-4.7", ["grok-4.7", "grok-4.6"]);
    Object.assign(session.services, { modelsManager: undefined });
    Object.assign(session, { modelInfo: {
      slug: "grok-4.7", modelMessages: { instructionsTemplate: "Grok 4.7-only note" },
      supportsPersonality: true,
    } });
    const child = await childModelInfo(session, { provider: "grok", model: "grok-4.6" });
    expect(child.slug).toBe("grok-4.6");
    expect(child.modelMessages).toBeUndefined();
    expect(child.supportsPersonality).toBe(false);
  });

  it("resumes an approved destination after an unrelated catalog addition, while checking its own destination and tools", async () => {
    let config: ReturnType<typeof defaultConfig> = { ...defaultConfig(), model_provider: "grok", model: "grok-4.6",
      agents: { cross_provider_enabled: true, allowed_providers: ["deepseek"] } };
    const session = sessionWithModels("grok", "grok-4.6", ["grok-4.6"]);
    Object.assign(session, { conversationId: "catalog-parent",
      sessionConfiguration: { cwd: "/workspace", collaborationMode: { model: "grok-4.6" } },
      providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }),
        previewChildDestination: async () => ({ endpoint: "https://api.deepseek.com/v1",
          authProfile: "api_key", billingSource: "byok" }) } });
    Object.assign(session.services, { configStore: { current: () => config },
      crossProviderConsent: { ownerSessionId: "catalog-parent", sessionEpoch: "epoch",
        request: async (_session: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => ({
          kind: "granted" as const, grant: { kind: "once" as const, ownerSessionId: "catalog-parent",
            sessionEpoch: "epoch", taskId: disclosure.taskId, scopeKey: disclosure.scopeKey,
            payloadKey: disclosure.payloadKey },
        }) } });
    const proposed = await createChildExecutionPlan({ session,
      selection: { provider: "deepseek", model: "deepseek-v4-pro" },
      modelInfo: { slug: "deepseek-v4-pro", provider: "deepseek", supportsToolUse: true } as Session["modelInfo"],
      parentPath: "/root", taskId: "catalog-child", taskName: "worker", taskText: "inspect",
      toolFree: false, forkedHistory: false });
    const approved = await authorizeChildExecutionPlan(session, proposed);
    if (approved.kind !== "granted") throw new Error("fixture consent was not granted");
    await assertChildExecutionPlan(session, approved.plan);
    config = { ...config, providers: { ollama: { default_model: "my-local-finetune" } } };
    await expect(assertChildExecutionPlan(session, approved.plan)).resolves.toBeUndefined();
    const binding = { authProfile: "api_key", billingSource: "byok", binding: {
      provider: "deepseek", model: "deepseek-v4-pro", factoryOptions: { baseURL: "https://api.deepseek.com/v1" } } };
    expect(() => assertPreparedChildMatchesPlan(approved.plan, { ...binding, binding: {
      ...binding.binding, factoryOptions: { baseURL: "https://changed.example/v1" } } } as never))
      .toThrow(/endpoint differs/u);
    expect(() => assertPreparedChildMatchesPlan(approved.plan, { ...binding,
      signInModelCapabilities: { supportsToolUse: false } } as never))
      .toThrow(/no longer supports child tools/u);
  });
  it("does not discover with a child's credential before its endpoint and consent are checked", async () => {
    const session = sessionWithModels("grok", "grok-4.6", ["grok-4.6"]);
    const wire = vi.fn(async () => new Response("{}"));
    const config = session.services.configStore.current();
    Object.assign(session.services, { modelsManager: new StaticModelsManager({ config,
      fallbackProvider: "grok", metadata: { env: {
        DEEPSEEK_BASE_URL: "https://receiver.example/v1", DEEPSEEK_API_KEY: "child-secret",
      }, fetchImpl: wire as typeof fetch } }) });
    await childModelInfo(session, { provider: "deepseek", model: "deepseek-v4-pro" });
    expect(wire).not.toHaveBeenCalled();
  });

  it("keeps same-provider managed AgenC admission under the default policy", async () => {
    const session = sessionWithModels("agenc", "agenc", ["agenc"], {
      agents: { cross_provider_enabled: false, allowed_providers: [] },
    });
    Object.assign(session, { conversationId: "managed-root",
      sessionConfiguration: { cwd: "/repo", collaborationMode: { model: "agenc" } },
      providerService: { current: () => ({ provider: "agenc", model: "agenc" }),
        resolveManagedChildDestination: async () => ({ provider: "deepseek", model: "deepseek-v4-pro" }) } });
    const plan = await createChildExecutionPlan({ session,
      selection: { provider: "agenc", model: "agenc" },
      modelInfo: { slug: "agenc", supportsToolUse: true } as Session["modelInfo"],
      parentPath: "/root", taskId: "managed-task", taskName: "worker", taskText: "inspect",
      toolFree: false, forkedHistory: false });
    expect(plan.crossProvider).toBe(false);
    expect(plan.destination.provider).toBe("deepseek");
  });

  it("does not ask the managed backend to infer a cross-provider destination before consent", async () => {
    const session = sessionWithModels("grok", "grok-4.6", ["grok-4.6"], {
      agents: { cross_provider_enabled: true, allowed_providers: ["agenc", "deepseek"] },
    });
    const infer = vi.fn(async () => ({ provider: "deepseek", model: "deepseek-v4-pro" }));
    Object.assign(session, { conversationId: "managed-parent",
      sessionConfiguration: { cwd: "/repo", collaborationMode: { model: "grok-4.6" } },
      providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }),
        resolveManagedChildDestination: infer,
        previewChildDestination: async () => ({ endpoint: "https://api.agenc.ai/v1",
          authProfile: "managed", billingSource: "managed" }) } });
    await expect(createChildExecutionPlan({ session,
      selection: { provider: "agenc", model: "agenc" },
      modelInfo: { slug: "agenc", supportsToolUse: true } as Session["modelInfo"],
      parentPath: "/root", taskId: "managed-task", taskName: "worker", taskText: "inspect",
      toolFree: false, forkedHistory: false })).rejects.toThrow(/consent_unavailable/u);
    expect(infer).not.toHaveBeenCalled();
  });

  it("discloses the managed route before inference and the concrete destination afterward", async () => {
    const session = sessionWithModels("grok", "grok-4.6", ["grok-4.6"], {
      agents: { cross_provider_enabled: true, allowed_providers: ["agenc", "deepseek"] },
    });
    const order: string[] = [];
    Object.assign(session, { conversationId: "managed-parent",
      sessionConfiguration: { cwd: "/repo", collaborationMode: { model: "grok-4.6" } },
      providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }),
        resolveManagedChildDestination: async () => { order.push("infer");
          return { provider: "deepseek", model: "deepseek-v4-pro" }; },
        previewChildDestination: async (_selection: unknown, concrete: { provider: string }) => ({
          endpoint: concrete?.provider === "agenc" ? "https://id.agenc.ag/v1" : "https://api.deepseek.com/v1",
          authProfile: "managed", billingSource: "managed" }),
      } });
    Object.assign(session.services, { crossProviderConsent: {
      ownerSessionId: "managed-parent", sessionEpoch: "epoch",
      request: async (_requester: Session, disclosure: { provider: string; taskId: string; scopeKey: string; payloadKey: string }) => {
        order.push(`consent:${disclosure.provider}`);
        return { kind: "granted" as const, grant: { kind: "once" as const,
          ownerSessionId: "managed-parent", sessionEpoch: "epoch", taskId: disclosure.taskId,
          scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey } };
      },
    } });
    const proposed = await createChildExecutionPlan({ session,
      selection: { provider: "agenc", model: "agenc" },
      modelInfo: { slug: "agenc", supportsToolUse: true } as Session["modelInfo"],
      parentPath: "/root", taskId: "managed-task", taskName: "worker", taskText: "inspect",
      toolFree: false, forkedHistory: false });
    expect(proposed.destination.provider).toBe("deepseek");
    expect((await authorizeChildExecutionPlan(session, proposed)).kind).toBe("granted");
    expect(order).toEqual(["consent:agenc", "infer", "consent:deepseek"]);
  });
  it("checks sign-in tool capability after consent on the pinned preparation", async () => {
    const session = sessionWithModels("grok", "grok-4.6", ["grok-4.6"], {
      agents: { cross_provider_enabled: true, allowed_providers: ["openai"] },
    });
    Object.assign(session, {
      conversationId: "sign-in-parent",
      sessionConfiguration: { cwd: "/workspace", collaborationMode: { model: "grok-4.6" } },
      providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }),
        previewChildDestination: async () => ({ endpoint: "https://chatgpt.com/backend-api/codex",
          authProfile: "sign_in", billingSource: "sign_in" }),
        prepareChild: async () => ({ authProfile: "sign_in", billingSource: "sign_in",
          signInModelCapabilities: { supportsToolUse: false },
          binding: { instance: { dispose: () => {} },
            factoryOptions: { baseURL: "https://chatgpt.com/backend-api/codex" } } }) },
    });
    const args = { session, selection: { provider: "openai", model: "gpt-6-luna" },
      modelInfo: { slug: "gpt-6-luna", provider: "openai", supportsToolUse: true } as Session["modelInfo"],
      parentPath: "/root", taskId: "worker", taskName: "worker", taskText: "inspect",
      forkedHistory: false };
    const normal = await createChildExecutionPlan({ ...args, toolFree: false });
    expect(() => assertPreparedChildMatchesPlan(normal, {
      authProfile: "sign_in", billingSource: "sign_in", signInModelCapabilities: { supportsToolUse: false },
      binding: { provider: "openai", model: "gpt-6-luna", factoryOptions: { baseURL: "https://chatgpt.com/backend-api/codex" } },
    } as never)).toThrow(/no longer supports child tools/u);
    const free = await createChildExecutionPlan({ ...args, toolFree: true });
    expect(free.requiredCapabilities.clientTools).toBe(false);
  });

  it("admits a model on the sign-in list even if the API-key catalog lacks it", async () => {
    const session = sessionWithModels("grok", "grok-4.6", ["grok-4.6"], {
      agents: { cross_provider_enabled: true, allowed_providers: ["openai"] },
    });
    const dispose = vi.fn();
    const prepareChild = vi.fn(async () => ({ authProfile: "sign_in",
      binding: { instance: { dispose } } }));
    Object.assign(session, { providerService: {
      current: () => ({ provider: "grok", model: "grok-4.6" }), prepareChild,
      previewChildDestination: async () => ({ endpoint: "https://chatgpt.com/backend-api/codex",
        authProfile: "sign_in", billingSource: "sign_in" }),
    } });
    expect(await resolveChildSelection(session, "openai", "gpt-6-subscription-only"))
      .toEqual({ provider: "openai", model: "gpt-6-subscription-only" });
    expect(prepareChild).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });
  it("accepts a live-only local model with a real configStore and no provider", async () => {
    const session = sessionWithModels("ollama", "llama3.3", ["llama3.3", "team/custom-local"]);
    expect(await resolveChildSelection(session, undefined, "team/custom-local"))
      .toEqual({ provider: "ollama", model: "team/custom-local" });
  });

  it("keeps a discovered Ollama model bound to Ollama", async () => {
    const session = sessionWithModels("ollama", "llama3.3", ["llama3.3", "team/discovered"]);
    session.services.modelsManager.tryListModels = () => [
      { slug: "llama3.3", provider: "ollama" },
      { slug: "team/discovered", provider: "ollama" },
      { slug: "deepseek-v4-pro", provider: "deepseek" },
    ];
    expect(await resolveChildSelection(session, undefined, "team/discovered"))
      .toEqual({ provider: "ollama", model: "team/discovered" });
    await expect(resolveChildSelection(session, undefined, "deepseek-v4-pro"))
      .rejects.toThrow(/deepseek\/deepseek-v4-pro/u);
  });

  it("does not use another provider's catalog row as local discovery", async () => {
    const session = sessionWithModels("grok", "grok-4.6", []);
    const config = session.services.configStore.current();
    session.services.modelsManager = new StaticModelsManager({ config, fallbackProvider: "grok" });
    await expect(resolveChildSelection(session, undefined, "deepseek-v4-pro"))
      .rejects.toThrow(/deepseek\/deepseek-v4-pro/u);
  });

  it("uses the local model registry before consent rather than the live metadata resolver", async () => {
    const session = sessionWithModels("grok", "grok-4.6", ["grok-4.6"]);
    const captured = { slug: "deepseek-v4-pro", provider: "deepseek", contextWindow: 777_777 };
    const getModelInfoForProvider = vi.fn(async () => captured);
    Object.assign(session.services, { modelsManager: { getModelInfoForProvider } });
    expect(await childModelInfo(session, { provider: "deepseek", model: "deepseek-v4-pro" }))
      .toMatchObject({ slug: "deepseek-v4-pro", provider: "deepseek", supportsToolUse: true });
    expect(getModelInfoForProvider).not.toHaveBeenCalled();
  });

  it("uses captured local environment without fetching cross-provider metadata", async () => {
    const session = sessionWithModels("grok", "grok-4.6", ["grok-4.6"]);
    const previous = process.env.DEEPSEEK_BASE_URL;
    process.env.DEEPSEEK_BASE_URL = "https://ambient.example/v1";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("api.deepseek.com/v1/models");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer captured-key" });
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-pro", context_length: 543_210 }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      Object.assign(session.services, { modelsManager: new StaticModelsManager({
        config: session.services.configStore.current(), fallbackProvider: "grok",
        metadata: { env: { DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
          DEEPSEEK_API_KEY: "captured-key", AGENC_MAX_OUTPUT_TOKENS: "4096" },
          fetchImpl: fetchImpl as typeof fetch },
      }) });
      const info = await childModelInfo(session, { provider: "deepseek", model: "deepseek-v4-pro" });
      expect(info.contextWindow).toBeGreaterThan(0);
      expect(info.maxOutputTokens).toBe(64_000);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_BASE_URL;
      else process.env.DEEPSEEK_BASE_URL = previous;
    }
  });

  it("refuses managed AgenC when its concrete destination is not allowed", async () => {
    const session = sessionWithModels("grok", "grok-4.6", ["grok-4.6"], {
      agents: { cross_provider_enabled: true, allowed_providers: ["agenc"] },
    });
    Object.assign(session, {
      conversationId: "root", sessionConfiguration: { cwd: "/repo", collaborationMode: { model: "grok-4.6" } },
      providerService: {
        current: () => ({ provider: "grok", model: "grok-4.6" }),
        resolveManagedChildDestination: async () => ({ provider: "deepseek", model: "deepseek-v4-pro" }),
      },
    });
    Object.assign(session.services, { crossProviderConsent: {
      ownerSessionId: "root", sessionEpoch: "epoch",
      request: async (_requester: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => ({
        kind: "granted" as const, grant: { kind: "once" as const,
          ownerSessionId: "root", sessionEpoch: "epoch", taskId: disclosure.taskId,
          scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey },
      }),
    } });
    await expect(createChildExecutionPlan({
      session, selection: { provider: "agenc", model: "agenc" },
      modelInfo: { slug: "agenc" } as Session["modelInfo"],
      parentPath: "/root", taskId: "task", taskName: "worker",
      toolFree: false, forkedHistory: false,
    })).rejects.toThrow(/deepseek.*not allowed/u);
  });

  it("accepts a live-only local model with the parent's explicit provider", async () => {
    const session = sessionWithModels("ollama", "llama3.3", ["llama3.3", "team/custom-local"]);
    expect(await resolveChildSelection(session, "ollama", "team/custom-local"))
      .toEqual({ provider: "ollama", model: "team/custom-local" });
  });

  it("keeps an ambiguous slug on the live provider when another provider catalogs it", async () => {
    const session = sessionWithModels("ollama", "llama3.3", ["llama3.3", "shared-model"], {
      providers: { deepseek: { default_model: "shared-model" } },
    });
    expect(await resolveChildSelection(session, undefined, "shared-model"))
      .toEqual({ provider: "ollama", model: "shared-model" });
  });

  it("accepts an explicit OpenRouter slash model before parsing a qualifier", async () => {
    const session = sessionWithModels("grok", "grok-4.6", ["grok-4.6"]);
    expect(await resolveChildSelection(session, "openrouter", "openai/gpt-4o-mini"))
      .toEqual({ provider: "openrouter", model: "openai/gpt-4o-mini" });
    expect(await resolveChildSelection(session, undefined, "deepseek/deepseek-v4-pro"))
      .toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
  });

});
