import { afterEach, describe, expect, it } from "vitest";

import {
  OPENROUTER_ZDR_OFF_HINT,
  openRouterZeroDataRetentionEnabled,
  resolveZeroDataRetentionStatus,
} from "./zero-data-retention.js";
import {
  recordOpenRouterZdrEndpoints,
  resetOpenRouterZdrEndpointsForTesting,
} from "./registry/openrouter-zdr-endpoints.js";
import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  builtInProviderIds,
} from "./registry/provider-info.js";
import type { VeniceModel } from "./registry/venice-models.js";
import { KIMI_CHAT_MODELS } from "./registry/kimi-models.js";

afterEach(() => resetOpenRouterZdrEndpointsForTesting());

function state(provider: string, model?: string, options: {
  readonly config?: Record<string, unknown>;
  readonly env?: Record<string, string>;
  readonly veniceModels?: readonly VeniceModel[];
} = {}) {
  return resolveZeroDataRetentionStatus({
    provider,
    model: model ?? BUILT_IN_PROVIDER_DEFINITIONS[provider as keyof typeof BUILT_IN_PROVIDER_DEFINITIONS].defaultModel,
    config: options.config ?? {},
    env: options.env ?? {},
    ...(options.veniceModels !== undefined ? { veniceModels: options.veniceModels } : {}),
  });
}

describe("OpenRouter zero data retention default", () => {
  it("is on unless the config turns it off", () => {
    expect(openRouterZeroDataRetentionEnabled(undefined)).toBe(true);
    expect(openRouterZeroDataRetentionEnabled({})).toBe(true);
    expect(openRouterZeroDataRetentionEnabled({ providers: { openrouter: {} } })).toBe(true);
    expect(openRouterZeroDataRetentionEnabled({ providers: { openrouter: { zero_data_retention: true } } })).toBe(true);
    expect(openRouterZeroDataRetentionEnabled({ providers: { openrouter: { zero_data_retention: false } } })).toBe(false);
  });
});

describe("ZDR badge state", () => {
  it("does not infer enterprise ZDR from any native Kimi model's capabilities", () => {
    for (const model of KIMI_CHAT_MODELS) {
      expect(state("kimi", model)).toMatchObject({
        state: "retained",
        reason: expect.stringContaining("enterprise customers on request"),
      });
    }
  });

  it("uses OpenRouter endpoint eligibility and the request policy for Moonshot models", () => {
    recordOpenRouterZdrEndpoints({ data: [{ model_id: "moonshotai/kimi-k3" }] });
    expect(state("openrouter", "moonshotai/kimi-k3")?.state).toBe("zdr");
    expect(state("openrouter", "moonshotai/kimi-k3")?.reason).toContain("provider.zdr");
    expect(state("openrouter", "moonshotai/kimi-k3", {
      config: { providers: { openrouter: { zero_data_retention: false } } },
    })?.state).toBe("retained");
    expect(state("openrouter", "moonshotai/unlisted-model")?.state).toBe("retained");
    expect(state("openrouter", "moonshotai/kimi-k3", {
      config: { providers: { openrouter: { base_url: "https://proxy.example.com/v1" } } },
    })?.state).toBe("unknown");
    expect(state("kimi", "kimi-k3")?.state).toBe("retained");
  });

  it("does not advertise a retention guarantee for the retired account provider", () => {
    expect(resolveZeroDataRetentionStatus({ provider: "agenc", model: "agenc" })).toBeUndefined();
  });
  it("is green only where retention is guaranteed, at every provider's defaults", () => {
    const states = Object.fromEntries(builtInProviderIds().map(provider => [provider, state(provider)?.state]));
    expect(states).toEqual({
      grok: "retained",
      openai: "retained",
      anthropic: "retained",
      ollama: "zdr",
      lmstudio: "zdr",
      // A server on this computer may be a proxy to a cloud API.
      "openai-compatible": "unknown",
      openrouter: "zdr",
      // The default Venice model is private.
      venice: "zdr",
      abliteration: "zdr",
      groq: "retained",
      deepseek: "retained",
      meta: "retained",
      qwen: "retained",
      "qwen-token-plan": "retained",
      "ollama-cloud": "zdr",
      cerebras: "zdr",
      zai: "retained",
      "zai-coding-plan": "retained",
      gemini: "retained",
      kimi: "retained",
      mistral: "retained",
      "nvidia-nim": "retained",
      minimax: "retained",
      github: "retained",
      "amazon-bedrock": "retained",
    });
  });

  it("explains a red badge with where ZDR lives for that provider", () => {
    expect(state("grok")?.reason).toContain("team setting in the xAI Console");
    expect(state("deepseek")?.reason).toContain("offers no ZDR");
    for (const provider of builtInProviderIds()) {
      expect(state(provider)?.reason, provider).not.toContain("—");
    }
  });

  it("turns red on OpenRouter when zero data retention is turned off", () => {
    const off = state("openrouter", "x-ai/grok-4.5", { config: { providers: { openrouter: { zero_data_retention: false } } } });
    expect(off?.state).toBe("retained");
    expect(off?.reason).toContain("off under [providers.openrouter]");
  });

  it("turns red for an OpenRouter model with no zero-retention endpoint, with the way out", () => {
    recordOpenRouterZdrEndpoints({ data: [{ model_id: "deepseek/deepseek-v4.1-flash" }] });
    expect(state("openrouter", "deepseek/deepseek-v4.1-flash")?.state).toBe("zdr");
    const missing = state("openrouter", "google/gemini-2.5-flash");
    expect(missing?.state).toBe("retained");
    expect(missing?.reason).toContain(OPENROUTER_ZDR_OFF_HINT);
    // A router id is filtered by OpenRouter itself.
    expect(state("openrouter", "openrouter/auto")?.state).toBe("zdr");
  });

  it("is unknown when a provider that would be green is pointed at another address", () => {
    expect(state("openai-compatible", "m", { env: { OPENAI_COMPATIBLE_BASE_URL: "https://api.together.xyz/v1" } })).toMatchObject({
      state: "unknown",
      reason: expect.stringContaining("api.together.xyz"),
    });
    expect(state("ollama", "llama3.3", { env: { OLLAMA_BASE_URL: "http://192.168.1.218:11434" } })?.state).toBe("unknown");
    expect(state("cerebras", "gpt-oss-120b", { env: { CEREBRAS_BASE_URL: "https://proxy.example.com/v1" } })?.state).toBe("unknown");
    expect(state("openrouter", "x-ai/grok-4.5", { config: { providers: { openrouter: { base_url: "http://127.0.0.1:9000/v1" } } } })?.state).toBe("unknown");
  });

  it("stays green for Ollama and LM Studio on any loopback address and for the provider's own host", () => {
    for (const url of ["http://127.0.0.1:8000/v1", "http://localhost:1234/v1", "http://[::1]:11434", "http://studio.localhost:1234/v1"]) {
      expect(state("openai-compatible", "m", { env: { OPENAI_COMPATIBLE_BASE_URL: url } })).toMatchObject({
        state: "unknown",
        reason: expect.stringContaining("may forward them to a cloud API"),
      });
    }
    expect(state("ollama", "llama3.3", { env: { OLLAMA_BASE_URL: "http://127.0.0.1:11434" } })?.state).toBe("zdr");
    expect(state("lmstudio", "m", { env: { LMSTUDIO_BASE_URL: "http://localhost:1234/v1" } })?.state).toBe("zdr");
    expect(state("cerebras", "gpt-oss-120b", { env: { CEREBRAS_BASE_URL: "https://api.cerebras.ai/v1/" } })?.state).toBe("zdr");
  });

  it("stays red when a provider that keeps data is pointed at another address", () => {
    expect(state("deepseek", "deepseek-flash", { env: { DEEPSEEK_BASE_URL: "http://127.0.0.1:9000/v1" } })?.state).toBe("retained");
  });

  it("follows Venice's privacy per model", () => {
    const models = [
      { model: "private-model", zeroDataRetention: true, privacy: "private" },
      { model: "anonymized-model", privacy: "anonymized" },
    ] as unknown as readonly VeniceModel[];
    expect(state("venice", "private-model", { veniceModels: models })?.state).toBe("zdr");
    expect(state("venice", "anonymized-model", { veniceModels: models })?.state).toBe("retained");
    expect(state("venice", "not-listed", { veniceModels: models })?.state).toBe("unknown");
  });

  it("knows nothing about a provider AgenC does not ship", () => {
    expect(resolveZeroDataRetentionStatus({ provider: "unknown", model: "x" })).toBeUndefined();
  });
});
