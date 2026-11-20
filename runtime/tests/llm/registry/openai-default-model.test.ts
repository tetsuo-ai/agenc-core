import { describe, expect, test } from "vitest";

import { defaultConfig } from "../../../src/config/schema.js";
import { defaultModelForProvider } from "../../../src/config/resolve-model.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import {
  OPENAI_DEFAULT_MODEL,
  OPENAI_REASONING_MODELS,
} from "../../../src/llm/registry/openai-reasoning-models.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../../src/llm/registry/provider-info.js";
import { createInitialFirstRunOnboardingState } from "../../../src/onboarding/Onboarding.js";
import {
  ALL_MODEL_CONFIGS,
  OPENAI_MODEL_DEFAULTS,
  modelConfigIdForProvider,
  resolveProviderModelAlias,
  type ModelKey,
} from "../../../src/utils/model/configs.js";
import { getGoalDefaultOpenAIModel } from "../../../src/utils/providerRecommendation.js";

const ASTRA = "gpt-6.2-astra";
const TIERS = Object.keys(ALL_MODEL_CONFIGS) as ModelKey[];

/**
 * The owner chose GPT-6.2 Astra as OpenAI's default on 2026-11-20: the former
 * default gpt-5 shuts down on 2026-12-11 (developers.openai.com/api/docs/deprecations).
 */
describe("OpenAI's default model", () => {
  test("is GPT-6.2 Astra, and it leads the OpenAI catalog", () => {
    expect(OPENAI_DEFAULT_MODEL).toBe(ASTRA);
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.openai).toBe(ASTRA);
    expect(defaultModelForProvider("openai")).toBe(ASTRA);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openai[0]).toBe(ASTRA);
    expect(OPENAI_REASONING_MODELS[0]?.model).toBe(ASTRA);
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: ASTRA })).toMatchObject({
      model: ASTRA, displayName: "GPT-6.2 Astra", contextWindow: 1_050_000, maxOutputTokens: 128_000,
      supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max"], visibility: "list",
    });
    // gpt-5 stays selectable, after the current lineup.
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openai).toContain("gpt-5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openai.indexOf("gpt-5"))
      .toBeGreaterThan(BUILT_IN_PROVIDER_MODEL_CATALOG.openai.indexOf("gpt-5.2"));
  });

  test("every model tier names it for OpenAI", () => {
    for (const tier of TIERS) {
      expect(ALL_MODEL_CONFIGS[tier].openai, tier).toBe(ASTRA);
      expect(modelConfigIdForProvider("openai", tier), tier).toBe(ASTRA);
    }
    expect(OPENAI_MODEL_DEFAULTS).toEqual({ opus: ASTRA, sonnet: ASTRA, haiku: ASTRA });
    expect(resolveProviderModelAlias("openai", "opus")).toBe(ASTRA);
    expect(resolveProviderModelAlias("openai", "sonnet")).toBe(ASTRA);
    expect(resolveProviderModelAlias("openai", "haiku[1m]")).toBe(`${ASTRA}[1m]`);
  });

  test("the providers that borrowed OpenAI's tier names keep them", () => {
    for (const provider of ["lmstudio", "openai-compatible", "ollama", "openrouter", "groq", "deepseek", "meta", "kimi"]) {
      expect(resolveProviderModelAlias(provider, "haiku"), provider).toBe("gpt-4o-mini");
      expect(resolveProviderModelAlias(provider, "opus"), provider).toBe("gpt-4o");
      expect(resolveProviderModelAlias(provider, "sonnet"), provider).toBe("gpt-4o");
    }
    expect(modelConfigIdForProvider("lmstudio", "sonnet40")).toBe("gpt-4o-mini");
    // Providers with their own column are untouched.
    expect(modelConfigIdForProvider("nvidia-nim", "opus47")).toBe("nvidia/nemotron-3.5-super-vl-120b-a12b");
    expect(modelConfigIdForProvider("gemini", "haiku45")).toBe("gemini-3.5-flash-lite");
  });

  test("setup recommends it for every goal", () => {
    expect(getGoalDefaultOpenAIModel("latency")).toBe(ASTRA);
    expect(getGoalDefaultOpenAIModel("balanced")).toBe(ASTRA);
    expect(getGoalDefaultOpenAIModel("coding")).toBe(ASTRA);
  });

  test("onboarding starts OpenAI on it", () => {
    const { model: _savedModel, ...config } = defaultConfig();
    const state = createInitialFirstRunOnboardingState({
      config: { ...config, model_provider: "openai" },
      env: {},
    });
    expect(state).toMatchObject({ selectedProvider: "openai", selectedModel: ASTRA });
  });
});
