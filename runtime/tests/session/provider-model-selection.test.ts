import { describe, expect, test } from "vitest";

import { defaultConfig, mergeConfigs } from "../../src/config/schema.js";
import {
  resolveProviderModelSelection,
  type SessionSelection,
} from "../../src/session/provider-model-selection.js";
import { ModelNotAllowedError } from "../../src/utils/model/modelAllowlist.js";

const CURRENT: SessionSelection = Object.freeze({
  provider: "grok",
  model: "grok-4.6",
});

describe("session provider/model policy boundary", () => {
  test("allows selection when managed policy is absent", () => {
    expect(
      resolveProviderModelSelection(defaultConfig(), CURRENT, {
        model_provider: "openai",
        model: "gpt-5",
      }),
    ).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      providerChanged: true,
    });
  });

  test("allows only models admitted by the final managed policy", () => {
    const config = mergeConfigs(defaultConfig(), {
      availableModels: ["gpt-5"],
    });
    expect(
      resolveProviderModelSelection(config, CURRENT, {
        model_provider: "openai",
        model: "gpt-5",
      }),
    ).toMatchObject({ provider: "openai", model: "gpt-5" });
    expect(() =>
      resolveProviderModelSelection(config, CURRENT, {
        model_provider: "grok",
        model: "grok-4.6",
      })
    ).toThrow(ModelNotAllowedError);
  });

  test("treats an explicit empty allowlist as deny-all", () => {
    const config = mergeConfigs(defaultConfig(), { availableModels: [] });
    expect(() =>
      resolveProviderModelSelection(config, CURRENT, {
        model: "grok-4.6",
      })
    ).toThrow(/managed availableModels policy/u);
  });

  test("rejects a provider-only switch when its resolved default is forbidden", () => {
    const config = mergeConfigs(defaultConfig(), {
      availableModels: ["grok-4.6"],
    });
    expect(() =>
      resolveProviderModelSelection(config, CURRENT, {
        model_provider: "openai",
      })
    ).toThrow(/model 'gpt-5' is not allowed/u);
  });

  test("uses collision-safe policy IDs without storing them in session state", () => {
    const config = mergeConfigs(defaultConfig(), {
      availableModels: ["github:copilot:gpt-5.3-codex"],
    });
    expect(
      resolveProviderModelSelection(config, CURRENT, {
        model_provider: "github",
        model: "gpt-5.3-codex",
      }),
    ).toMatchObject({
      provider: "github",
      model: "gpt-5.3-codex",
    });
    expect(() =>
      resolveProviderModelSelection(config, CURRENT, {
        model: "gpt-5.3-codex",
      })
    ).toThrow(ModelNotAllowedError);
  });
});


describe("model catalog admission", () => {
  const current = { provider: "deepseek", model: "deepseek-flash" };

  test.each(["xyz", "deepseek-flsh", "deepseek:deepseek-flsh"])(
    "rejects fixed-catalog input %s with a closest-name hint", (model) => {
      expect(() => resolveProviderModelSelection({}, current, { model }))
        .toThrow(/unknown model .*deepseek.*[Dd]id you mean 'deepseek-flash'/u);
      expect(current).toEqual({ provider: "deepseek", model: "deepseek-flash" });
    },
  );

  test.each(["grok", "openai", "anthropic"])(
    "rejects unknown names on %s", (provider) => {
      expect(() => resolveProviderModelSelection({}, current, {
        model_provider: provider, model: "xyz",
      }, {})).toThrow(/unknown model .*did you mean/iu);
    },
  );

  // Venice's list is its live /models answer (128 tool-capable models on
  // 2026-10-15), not the 3-model offline snapshot; Venice itself refuses an
  // ID it does not serve before the first request.
  test.each([
    [{ model_provider: "venice", model: "deepseek-v4-flash" }, "deepseek-v4-flash"],
    [{ model: "venice:claude-opus-5-5" }, "claude-opus-5-5"],
    [{ model_provider: "venice", model: "qwen3-5-397b-a17b" }, "qwen3-5-397b-a17b"],
  ] as const)("accepts a live Venice model the bundled snapshot lacks: %o", (layer, model) => {
    expect(resolveProviderModelSelection({}, current, layer, {}))
      .toMatchObject({ provider: "venice", model });
  });

  test.each(["ollama", "lmstudio", "openai-compatible", "openrouter"])(
    "accepts a custom name on open provider %s", (provider) => {
      expect(resolveProviderModelSelection({}, current, {
        model_provider: provider, model: "my-custom-model",
      })).toMatchObject({ provider, model: "my-custom-model" });
    },
  );

  test("accepts custom names at a configured OpenAI-compatible endpoint", () => {
    expect(resolveProviderModelSelection({ providers: {
      openai: { base_url: "http://localhost:8765/v1" },
    } }, current, { model_provider: "openai", model: "my-custom-model" }))
      .toMatchObject({ provider: "openai", model: "my-custom-model" });
  });

  test("does not admit an unknown fixed-catalog model just because it is configured", () => {
    expect(() => resolveProviderModelSelection({
      model_provider: "deepseek", model: "xyz",
      providers: { deepseek: { default_model: "xyz" } },
    }, current, { model: "xyz" })).toThrow(/unknown model/u);
  });

  test("still switches to a correct name", () => {
    expect(resolveProviderModelSelection({}, current, { model: "deepseek:deepseek-v4-pro" }))
      .toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
  });

  test("admits a private deployment named as a modelOverrides value", () => {
    const config = { modelOverrides: { "deepseek-flash": "private-flash-deployment" } };
    expect(resolveProviderModelSelection(config, current, { model: "private-flash-deployment" }))
      .toMatchObject({ provider: "deepseek", model: "private-flash-deployment" });
    expect(() => resolveProviderModelSelection(config, current, { model: "xyz" }))
      .toThrow(/unknown model .*did you mean 'deepseek-flash'/u);
    expect(() => resolveProviderModelSelection({
      modelOverrides: { "private-flash-deployment": "deepseek-flash" },
    }, current, { model: "private-flash-deployment" })).toThrow(/unknown model/u);
  });
});


test("uses the endpoint environment supplied by the caller", () => {
  const current = { provider: "deepseek", model: "deepseek-flash" };
  expect(resolveProviderModelSelection({}, current, {
    model_provider: "openai", model: "custom-model",
  }, { OPENAI_BASE_URL: "http://localhost:9876/v1" }))
    .toMatchObject({ provider: "openai", model: "custom-model" });
  expect(() => resolveProviderModelSelection({}, current, { model: "xyz" }, {
    DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1/",
  })).toThrow(/unknown model/u);
});


test("configured model admission keeps managed policy while allowing catalog drift", () => {
  const current = { provider: "deepseek", model: "retired-model" };
  expect(resolveProviderModelSelection({}, current, {}, {}, { validateCatalog: false }))
    .toMatchObject(current);
  expect(() => resolveProviderModelSelection({ availableModels: ["deepseek-flash"] }, current, {}, {}, { validateCatalog: false }))
    .toThrow(ModelNotAllowedError);
  expect(() => resolveProviderModelSelection({}, current, { model: "retired-model" }, {}))
    .toThrow(/unknown model/u);
});
