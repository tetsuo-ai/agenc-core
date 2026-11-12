import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assertModelCatalogSelection,
  assertModelNotRetired,
  openRouterSelectionNotice,
  retiredModelNotice,
} from "../../src/llm/model-catalog-selection.js";
import { openRouterCatalogEntry } from "../../src/llm/registry/openrouter-models.js";
import {
  clearPublishedModelCatalogs,
  recordPublishedModelCatalog,
} from "../../src/llm/registry/published-model-catalog.js";

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

/** Selection with nothing but the bundled catalog to read, at `now`. */
const select = (model: string, now: Date) => () =>
  assertModelCatalogSelection({}, "openrouter", model, {}, now);

// Bundled row dated 2026-12-31 (issue #3447).
const MODEL = "z-ai/glm-4.5";
const REFUSAL = "OpenRouter retired 'z-ai/glm-4.5' on 2026-12-31. Pick another model.";

describe("a model the bundled catalog says is retired", () => {
  test("is selectable the day before its date and refused on it and after", () => {
    expect(select(MODEL, at("2026-12-30", "23:59:59.999"))).not.toThrow();
    expect(select(MODEL, at("2026-12-31", "00:00:00.000"))).toThrow(new Error(REFUSAL));
    expect(select(MODEL, at("2027-03-01"))).toThrow(new Error(REFUSAL));
  });

  test("is refused although its id has the vendor/model shape an unverified id is accepted with", () => {
    const late = at("2027-03-01");
    // Without a live list any well-formed id is accepted unverified.
    expect(select("future/new-model", late)).not.toThrow();
    expect(openRouterSelectionNotice("future/new-model")).toContain("unverified");
    expect(select(MODEL, late)).toThrow(REFUSAL);
    // Letter case does not get a retired model through.
    expect(select("Z-AI/GLM-4.5", late)).toThrow(REFUSAL);
    // A different id is a different model: it stays unverified, not retired.
    expect(select(`${MODEL}:nitro`, late)).not.toThrow();
    expect(select("bad id", late)).toThrow("Invalid OpenRouter");
  });

  test("is accepted while the provider's live list has it", () => {
    recordLiveOpenRouterList("x-ai/grok-4.5", MODEL);
    expect(select(MODEL, at("2027-03-01"))).not.toThrow();
    expect(retiredModelNotice("openrouter", MODEL, at("2027-03-01"))).toBeUndefined();
  });

  test("is refused with its date when the live list no longer has it", () => {
    recordLiveOpenRouterList("x-ai/grok-4.5");
    expect(select(MODEL, at("2027-03-01"))).toThrow(REFUSAL);
    // Before the date the live list alone decides.
    expect(select(MODEL, at("2026-12-30"))).toThrow("does not list");
  });

  test("reads the system time when no clock is passed", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-12-30") });
    expect(() => assertModelCatalogSelection({}, "openrouter", MODEL, {})).not.toThrow();
    expect(() => assertModelNotRetired("openrouter", MODEL)).not.toThrow();
    expect(retiredModelNotice("openrouter", MODEL)).toBeUndefined();
    vi.setSystemTime(at("2026-12-31"));
    expect(() => assertModelCatalogSelection({}, "openrouter", MODEL, {})).toThrow(REFUSAL);
    expect(() => assertModelNotRetired("openrouter", MODEL)).toThrow(REFUSAL);
    expect(retiredModelNotice("openrouter", MODEL)).toBe(REFUSAL);
  });
});

describe("models without a retirement date", () => {
  test("are selectable at any time", () => {
    const farFuture = at("9999-12-31");
    expect(select("x-ai/grok-4.5", farFuture)).not.toThrow();
    expect(retiredModelNotice("openrouter", "x-ai/grok-4.5", farFuture)).toBeUndefined();
    expect(() => assertModelNotRetired("openrouter", "x-ai/grok-4.5", farFuture)).not.toThrow();
    // Other providers keep their own rules.
    expect(() => assertModelCatalogSelection({}, "deepseek", "deepseek-flash", {}, farFuture)).not.toThrow();
    expect(() => assertModelCatalogSelection({}, "deepseek", "deepseek-flsh", {}, farFuture))
      .toThrow("did you mean 'deepseek-flash'");
  });
});

describe("the bundled snapshot with the clock at 2026-11-12", () => {
  const today = at("2026-11-12");

  test.each([
    ["poolside/laguna-s-2.1", "2026-10-31"],
    ["poolside/laguna-s-2.1:free", "2026-10-31"],
    ["poolside/laguna-xs-2.1", "2026-10-31"],
    ["poolside/laguna-xs-2.1:free", "2026-10-31"],
    ["bytedance-seed/seed-1.6", "2026-11-11"],
    ["bytedance-seed/seed-1.6-flash", "2026-11-11"],
    ["bytedance-seed/seed-2.0-code", "2026-11-11"],
  ])("refuses %s, naming %s", (model, date) => {
    expect(select(model, today))
      .toThrow(new Error(`OpenRouter retired '${model}' on ${date}. Pick another model.`));
  });

  test.each(["dots-studio/dots-3-note-preview:free", "z-ai/glm-4.5"])(
    "still accepts %s, which retires on 2026-12-31", (model) => {
      expect(select(model, today)).not.toThrow();
    },
  );
});
