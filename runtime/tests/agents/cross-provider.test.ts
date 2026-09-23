import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config/schema.js";
import { resolveChildSelection } from "../../src/agents/cross-provider.js";
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
