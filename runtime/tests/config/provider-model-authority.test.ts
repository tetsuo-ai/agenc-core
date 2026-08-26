import { describe, expect, test } from "vitest";

import {
  buildProviderModelCatalog,
  mergeProviderModelLayer,
  resolveProviderModelLayer,
  resolveProviderSlugOrThrow,
  UnknownProviderError,
} from "../../src/config/provider-model-authority.js";
import {
  AmbiguousModelError,
  defaultConfig,
  mergeConfigs,
} from "../../src/config/schema.js";

describe("provider/model configuration authority", () => {
  test("reports unknown providers with a stable typed error", () => {
    let error: unknown;
    try {
      resolveProviderSlugOrThrow("not-a-provider");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UnknownProviderError);
    expect(error).toMatchObject({
      provider: "not-a-provider",
      expectedProviders: expect.arrayContaining(["grok", "openai"]),
    });
  });

  test("does not let the current pair teach the model catalog", () => {
    const catalog = buildProviderModelCatalog(
      mergeConfigs(defaultConfig(), {
        model_provider: "grok",
        model: "private-openai-model",
      }),
    );

    expect(catalog.grok).not.toContain("private-openai-model");
  });

  test("provider-only selection resets to that provider's built-in default", () => {
    expect(
      resolveProviderModelLayer(defaultConfig(), {
        model_provider: "openai",
      }),
    ).toMatchObject({ model_provider: "openai", model: "gpt-5" });
  });

  test("provider-only selection respects that provider's configured default", () => {
    const base = mergeConfigs(defaultConfig(), {
      providers: { openai: { default_model: "private-openai-model" } },
    });

    expect(
      resolveProviderModelLayer(base, { model_provider: "openai" }),
    ).toMatchObject({
      model_provider: "openai",
      model: "private-openai-model",
    });
  });

  test("provider-only selection restores an explicit top-level pair", () => {
    const base = mergeConfigs(defaultConfig(), {
      model_provider: "openai",
      model: "gpt-5-mini",
      providers: { openai: { default_model: "gpt-5" } },
    });

    expect(
      resolveProviderModelLayer(base, { model_provider: "openai" }),
    ).toMatchObject({
      model_provider: "openai",
      model: "gpt-5-mini",
    });
  });

  test.each([
    ["gpt-5", "openai"],
    ["claude-opus-4-7", "anthropic"],
    ["agenc", "agenc"],
    ["amazon.nova-pro-v1:0", "amazon-bedrock"],
    ["github:copilot", "github"],
  ])("known model-only selection couples %s to %s", (model, provider) => {
    expect(resolveProviderModelLayer(defaultConfig(), { model })).toMatchObject(
      { model_provider: provider, model },
    );
  });

  test("unknown bare models stay on the inherited provider", () => {
    const base = mergeConfigs(defaultConfig(), {
      model_provider: "openai",
      model: "gpt-5",
    });

    expect(
      resolveProviderModelLayer(base, { model: "private-openai-model" }),
    ).toMatchObject({
      model_provider: "openai",
      model: "private-openai-model",
    });
  });

  test("a live provider qualifier explicitly selects an unknown model", () => {
    expect(
      resolveProviderModelLayer(defaultConfig(), {
        model: "openai:private-openai-model",
      }),
    ).toMatchObject({
      model_provider: "openai",
      model: "private-openai-model",
    });
  });

  test("ambiguous model-only selection fails", () => {
    const base = mergeConfigs(defaultConfig(), {
      providers: {
        grok: { default_model: "shared-model" },
        openai: { default_model: "shared-model" },
      },
    });

    expect(() =>
      resolveProviderModelLayer(base, { model: "shared-model" })
    ).toThrow(AmbiguousModelError);
  });

  test("an explicit provider disambiguates a shared model", () => {
    const base = mergeConfigs(defaultConfig(), {
      providers: {
        grok: { default_model: "shared-model" },
        openai: { default_model: "shared-model" },
      },
    });

    expect(
      resolveProviderModelLayer(base, {
        model_provider: "openai",
        model: "shared-model",
      }),
    ).toMatchObject({ model_provider: "openai", model: "shared-model" });
  });

  test("an explicit provider rejects a known foreign model", () => {
    expect(() =>
      resolveProviderModelLayer(defaultConfig(), {
        model_provider: "grok",
        model: "gpt-5",
      })
    ).toThrow(/belongs to provider 'openai'/u);
  });

  test("an explicit provider accepts its unknown private model", () => {
    expect(
      resolveProviderModelLayer(defaultConfig(), {
        model_provider: "openai",
        model: "private-openai-model",
      }),
    ).toMatchObject({
      model_provider: "openai",
      model: "private-openai-model",
    });
  });

  test("the agenc shortcut cannot be reassigned by a provider default", () => {
    const base = mergeConfigs(defaultConfig(), {
      providers: { openai: { default_model: "agenc" } },
    });

    expect(resolveProviderModelLayer(base, { model: "agenc" })).toMatchObject({
      model_provider: "agenc",
      model: "agenc",
    });
    expect(() =>
      resolveProviderModelLayer(base, {
        model_provider: "openai",
        model: "agenc",
      })
    ).toThrow(/belongs to provider 'agenc'/u);
    expect(() =>
      resolveProviderModelLayer(base, { model_provider: "openai" })
    ).toThrow(/belongs to provider 'agenc'/u);
  });

  test("conflicting explicit provider and model qualifier fail", () => {
    expect(() =>
      resolveProviderModelLayer(defaultConfig(), {
        model_provider: "grok",
        model: "openai:private-openai-model",
      })
    ).toThrow(/not explicitly selected provider 'grok'/u);
  });

  test.each([
    [{ model_provider: "" }, /provider selection values must be non-empty/u],
    [{ model: " " }, /model selection values must be non-empty/u],
    [
      { model: "openai:" },
      /provider-qualified model values must include a model/u,
    ],
  ])("rejects empty selection input %#", (layer, expected) => {
    expect(() => resolveProviderModelLayer(defaultConfig(), layer)).toThrow(
      expected,
    );
  });

  test("mergeProviderModelLayer applies the resolved pair atomically", () => {
    expect(
      mergeProviderModelLayer(defaultConfig(), { model_provider: "anthropic" }),
    ).toMatchObject({
      model_provider: "anthropic",
      model: "claude-opus-4-7",
    });
  });
});
