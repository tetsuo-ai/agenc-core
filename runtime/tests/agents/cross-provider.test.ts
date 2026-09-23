import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/schema.js";
import { childModelInfo, createChildExecutionPlan, resolveChildSelection } from "../../src/agents/cross-provider.js";
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

  it("uses the session's captured metadata resolver for another provider", async () => {
    const session = sessionWithModels("grok", "grok-4.6", ["grok-4.6"]);
    const captured = { slug: "deepseek-v4-pro", provider: "deepseek", contextWindow: 777_777 };
    const getModelInfoForProvider = async (provider: string, model: string) => {
      expect([provider, model]).toEqual(["deepseek", "deepseek-v4-pro"]);
      return captured;
    };
    Object.assign(session.services, { modelsManager: { getModelInfoForProvider } });
    expect(await childModelInfo(session, { provider: "deepseek", model: "deepseek-v4-pro" }))
      .toBe(captured);
  });

  it("uses captured environment and fetch for cross-provider metadata", async () => {
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
      expect(info.contextWindow).toBe(543_210);
      expect(info.maxOutputTokens).toBe(4096);
      expect(fetchImpl).toHaveBeenCalled();
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
