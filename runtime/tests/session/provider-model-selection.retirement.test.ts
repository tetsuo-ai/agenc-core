import { afterEach, describe, expect, test, vi } from "vitest";
import { openRouterCatalogEntry } from "../../src/llm/registry/openrouter-models.js";
import {
  clearPublishedModelCatalogs,
  recordPublishedModelCatalog,
} from "../../src/llm/registry/published-model-catalog.js";
import {
  resolveProviderModelSelection,
  resolveSessionProviderModelSelection,
} from "../../src/session/provider-model-selection.js";

afterEach(() => {
  clearPublishedModelCatalogs();
  vi.useRealTimers();
});

const at = (day: string, time = "12:00:00.000"): Date => new Date(`${day}T${time}Z`);

function recordLiveOpenRouterList(...models: readonly string[]): void {
  recordPublishedModelCatalog("openrouter", models.map((model, index) => openRouterCatalogEntry({
    model, label: model, modalities: ["text"], parameters: ["tools"], efforts: [], pricing: {},
  }, index)), { replace: true });
}

// Bundled row dated 2026-12-31 (issue #3447).
const MODEL = "z-ai/glm-4.5";
const REFUSAL = "OpenRouter retired 'z-ai/glm-4.5' on 2026-12-31. Pick another model.";
const BEFORE = { now: at("2026-12-30", "23:59:59.999") };
const ON = { now: at("2026-12-31", "00:00:00.000") };
const AFTER = { now: at("2027-03-01") };
const ON_DEEPSEEK = { provider: "deepseek", model: "deepseek-flash" };

describe("choosing a model the bundled catalog says is retired", () => {
  test.each([
    { model_provider: "openrouter", model: MODEL },
    { model: `openrouter:${MODEL}` },
    // The catalog still names the provider of a bare id, so the refusal is OpenRouter's.
    { model: MODEL },
  ])("is accepted the day before its date and refused on it and after: %o", (layer) => {
    expect(resolveProviderModelSelection({}, ON_DEEPSEEK, layer, {}, BEFORE))
      .toEqual({ provider: "openrouter", model: MODEL, providerChanged: true });
    expect(() => resolveProviderModelSelection({}, ON_DEEPSEEK, layer, {}, ON)).toThrow(new Error(REFUSAL));
    expect(() => resolveProviderModelSelection({}, ON_DEEPSEEK, layer, {}, AFTER)).toThrow(new Error(REFUSAL));
  });

  test("is accepted while the provider's live list has it", () => {
    recordLiveOpenRouterList("x-ai/grok-4.5", MODEL);
    expect(resolveProviderModelSelection({}, ON_DEEPSEEK, { model_provider: "openrouter", model: MODEL }, {}, AFTER))
      .toMatchObject({ provider: "openrouter", model: MODEL });
  });

  test("reads the system time when no clock is passed", () => {
    const layer = { model_provider: "openrouter", model: MODEL };
    vi.useFakeTimers({ toFake: ["Date"], now: BEFORE.now });
    expect(resolveProviderModelSelection({}, ON_DEEPSEEK, layer, {})).toMatchObject({ model: MODEL });
    vi.setSystemTime(ON.now);
    expect(() => resolveProviderModelSelection({}, ON_DEEPSEEK, layer, {})).toThrow(REFUSAL);
  });
});

describe("a saved OpenRouter model that is retired", () => {
  const configs = [
    { model_provider: "openrouter", model: MODEL },
    { providers: { openrouter: { default_model: MODEL } } },
  ];
  const layers = [
    { model_provider: "openrouter" },
    { model_provider: "openrouter", model: MODEL },
  ];

  test.each(configs)("is preserved until its date, then refused when chosen again: %o", (config) => {
    for (const layer of layers) {
      expect(resolveProviderModelSelection(config, ON_DEEPSEEK, layer, {}, BEFORE))
        .toMatchObject({ provider: "openrouter", model: MODEL });
      expect(() => resolveProviderModelSelection(config, ON_DEEPSEEK, layer, {}, ON)).toThrow(new Error(REFUSAL));
      expect(() => resolveProviderModelSelection(config, ON_DEEPSEEK, layer, {}, AFTER)).toThrow(new Error(REFUSAL));
    }
  });

  test.each(configs)("keeps skipping the listing check, and follows the live list on retirement: %o", (config) => {
    // A saved pair outlives the public catalog while its date is ahead.
    recordLiveOpenRouterList("x-ai/grok-4.5");
    for (const layer of layers) {
      expect(resolveProviderModelSelection(config, ON_DEEPSEEK, layer, {}, BEFORE))
        .toMatchObject({ provider: "openrouter", model: MODEL });
      expect(() => resolveProviderModelSelection(config, ON_DEEPSEEK, layer, {}, AFTER)).toThrow(REFUSAL);
    }
    // A live list that still has the model keeps it selectable past the bundled date.
    recordLiveOpenRouterList("x-ai/grok-4.5", MODEL);
    for (const layer of layers) {
      expect(resolveProviderModelSelection(config, ON_DEEPSEEK, layer, {}, AFTER))
        .toMatchObject({ provider: "openrouter", model: MODEL });
    }
  });

  test.each(configs)("never blocks a pair that is replayed, not chosen: %o", (config) => {
    // Profiles, recovery, reload and restore pass validateCatalog: false.
    for (const layer of layers) {
      expect(resolveProviderModelSelection(config, ON_DEEPSEEK, layer, {}, { ...AFTER, validateCatalog: false }))
        .toMatchObject({ provider: "openrouter", model: MODEL });
    }
  });

  test("never blocks the switch to another model", () => {
    const config = { model_provider: "openrouter", model: MODEL };
    const onRetired = { provider: "openrouter", model: MODEL };
    expect(resolveProviderModelSelection(config, onRetired, { model: "x-ai/grok-4.5" }, {}, AFTER))
      .toEqual({ provider: "openrouter", model: "x-ai/grok-4.5", providerChanged: false });
    expect(resolveProviderModelSelection(config, onRetired, { model_provider: "deepseek" }, {}, AFTER))
      .toMatchObject({ provider: "deepseek", providerChanged: true });
    // Choosing the retired model again from that session is still refused.
    expect(() => resolveProviderModelSelection(config, onRetired, { model: MODEL }, {}, AFTER)).toThrow(REFUSAL);
  });
});

describe("resolveSessionProviderModelSelection", () => {
  const session = (config: unknown) => ({
    services: { configStore: { current: () => config }, providerEnvironment: {} },
    sessionConfiguration: { provider: { slug: "deepseek" }, collaborationMode: { model: "deepseek-flash" } },
  });

  test("passes the clock through to the catalog check", () => {
    const layer = { model_provider: "openrouter", model: MODEL };
    expect(resolveSessionProviderModelSelection(session({}), layer, BEFORE))
      .toMatchObject({ provider: "openrouter", model: MODEL });
    expect(() => resolveSessionProviderModelSelection(session({}), layer, AFTER)).toThrow(new Error(REFUSAL));
    expect(resolveSessionProviderModelSelection(session({}), layer, { ...AFTER, validateCatalog: false }))
      .toMatchObject({ provider: "openrouter", model: MODEL });
  });
});
