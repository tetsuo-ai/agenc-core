/**
 * Regression tests for "model-catalog-drift" (GAPs #8, #9, #10) — drift that
 * crept in after the single-source model-catalog refactor.
 *
 *  #8  configuredModelForProvider's cross-provider guard must reject ANY grok
 *      FAMILY model (e.g. the lead model "grok-build-0.1"), not just the single
 *      literal default "grok-4.3", so a grok model never leaks to a non-grok
 *      provider when `model_provider` is absent.
 *  #9  The openai built-in default ("gpt-5") must resolve through the
 *      single-source REGISTERED_MODEL_CATALOG, not heuristic fallback.
 *  #10 `visibility: "hide"` models (e.g. codex-auto-review) stay resolvable but
 *      must NOT be offered as selectable options in the /model picker.
 */

import { describe, expect, it } from "vitest";

import { defaultConfig } from "../../src/config/schema.js";
import type { AgenCConfig } from "../../src/config/schema.js";
import { configuredModelForProvider } from "../../src/config/resolve-model.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../src/llm/registry/provider-info.js";
import {
  REGISTERED_MODEL_CATALOG,
  deriveFlatCatalog,
  resolveRegisteredModelCatalogEntry,
} from "../../src/llm/registry/model-catalog.js";
import { readModelMenuSnapshot } from "../../src/commands/model-menu.js";
import type { SlashCommandContext } from "../../src/commands/types.js";

function configWithModelNoProvider(model: string): AgenCConfig {
  // Top-level model set, but `model_provider` absent — the exact condition the
  // GAP #8 guard protects.
  return {
    ...defaultConfig(),
    model,
    model_provider: undefined,
  } as unknown as AgenCConfig;
}

function ctxWithProvider(provider: string, model: string): SlashCommandContext {
  const config = { ...defaultConfig(), model, model_provider: provider };
  const session = {
    state: {
      unsafePeek: () => ({
        sessionConfiguration: {
          provider: { slug: provider },
          collaborationMode: { model },
        },
        history: [],
      }),
    },
    services: { configStore: { current: () => config } },
  };
  return {
    session,
    argsRaw: "",
    cwd: "/ws",
    home: "/home/test",
    configStore: { current: () => config },
  } as unknown as SlashCommandContext;
}

describe("GAP #8: grok-family cross-provider leak guard", () => {
  it("does not offer the grok lead model to a non-grok provider", () => {
    const config = configWithModelNoProvider("grok-build-0.1");
    // grok-build-0.1 is grok-only; offering it to openai would produce a
    // rejected API call.
    expect(configuredModelForProvider(config, "openai")).toBeUndefined();
  });

  it("does not offer the literal grok default to a non-grok provider", () => {
    const config = configWithModelNoProvider(BUILT_IN_PROVIDER_DEFAULT_MODELS.grok);
    expect(configuredModelForProvider(config, "openai")).toBeUndefined();
  });

  it("does not offer a prefixed grok-family model to a non-grok provider", () => {
    // A namespaced/prefixed grok id still resolves to the grok family.
    const config = configWithModelNoProvider("grok-4.3-fast");
    expect(configuredModelForProvider(config, "anthropic")).toBeUndefined();
  });

  it("still offers the grok model to the grok provider itself", () => {
    const config = configWithModelNoProvider("grok-build-0.1");
    expect(configuredModelForProvider(config, "grok")).toBe("grok-build-0.1");
  });

  it("does not block a non-grok model from a non-grok provider", () => {
    const config = configWithModelNoProvider("some-openai-model");
    expect(configuredModelForProvider(config, "openai")).toBe("some-openai-model");
  });
});

describe("GAP #9: openai default resolves via the single-source registry", () => {
  const openaiDefault = BUILT_IN_PROVIDER_DEFAULT_MODELS.openai;

  it("has a REGISTERED_MODEL_CATALOG entry for the openai default", () => {
    const entry = resolveRegisteredModelCatalogEntry({
      provider: "openai",
      model: openaiDefault,
    });
    expect(entry).toBeDefined();
    expect(entry?.model).toBe(openaiDefault);
    expect(entry?.provider).toBe("openai");
  });

  it("surfaces the openai default through the derived flat catalog", () => {
    expect(deriveFlatCatalog().openai).toContain(openaiDefault);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openai).toContain(openaiDefault);
  });
});

describe("GAP #10: hide-visibility models excluded from the /model picker", () => {
  const hiddenModels = REGISTERED_MODEL_CATALOG.filter(
    (entry) => entry.visibility === "hide",
  );

  it("has at least one hide-visibility model to guard against (fixture sanity)", () => {
    expect(hiddenModels.length).toBeGreaterThan(0);
  });

  it("keeps hide-visibility models RESOLVABLE in the flat catalog", () => {
    const flat = deriveFlatCatalog();
    for (const entry of hiddenModels) {
      const provider = entry.provider === "xai" ? "grok" : entry.provider;
      expect(flat[provider]).toContain(entry.model);
    }
  });

  it("excludes hide-visibility models from the /model picker rows", () => {
    const snapshot = readModelMenuSnapshot(ctxWithProvider("openai", "gpt-5"));
    const offered = new Set(snapshot.rows.map((row) => row.model));
    for (const entry of hiddenModels) {
      expect(offered.has(entry.model)).toBe(false);
    }
    // Sanity: a visible openai model IS offered.
    expect(offered.has(BUILT_IN_PROVIDER_DEFAULT_MODELS.openai)).toBe(true);
  });
});
