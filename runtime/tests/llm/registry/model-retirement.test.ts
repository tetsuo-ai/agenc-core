import { afterEach, describe, expect, test, vi } from "vitest";
import {
  findBundledModelCatalogEntry,
  REGISTERED_MODEL_CATALOG,
} from "../../../src/llm/registry/model-catalog.js";
import { isModelRetired, retiredBundledModel } from "../../../src/llm/registry/model-retirement.js";
import { openRouterCatalogEntry } from "../../../src/llm/registry/openrouter-models.js";
import {
  clearPublishedModelCatalogs,
  recordPublishedModelCatalog,
} from "../../../src/llm/registry/published-model-catalog.js";

afterEach(() => {
  clearPublishedModelCatalogs();
  vi.useRealTimers();
});

/** A clock on a UTC day, at noon unless a time is given. */
const at = (day: string, time = "12:00:00.000"): Date => new Date(`${day}T${time}Z`);

/** Record OpenRouter's live list as this process read it. */
function recordLiveOpenRouterList(...models: readonly string[]): void {
  recordPublishedModelCatalog("openrouter", models.map((model, index) => openRouterCatalogEntry({
    model, label: model, modalities: ["text"], parameters: ["tools"], efforts: [], pricing: {},
  }, index)), { replace: true });
}

// The bundled snapshot of 2026-10-20 as issue #3447 measured it. A
// regeneration replaces these rows and this list with them.
const RETIRED_BY_2026_11_12 = [
  ["poolside/laguna-s-2.1", "2026-10-31"],
  ["poolside/laguna-s-2.1:free", "2026-10-31"],
  ["poolside/laguna-xs-2.1", "2026-10-31"],
  ["poolside/laguna-xs-2.1:free", "2026-10-31"],
  ["bytedance-seed/seed-1.6", "2026-11-11"],
  ["bytedance-seed/seed-1.6-flash", "2026-11-11"],
  ["bytedance-seed/seed-2.0-code", "2026-11-11"],
] as const;
const RETIRING_2026_12_31 = [
  ["dots-studio/dots-3-note-preview:free", "2026-12-31"],
  ["z-ai/glm-4.5", "2026-12-31"],
] as const;

describe("isModelRetired", () => {
  const entry = { retiresOn: "2026-10-31" };

  test("an entry is retired from the first UTC instant of its date", () => {
    expect(isModelRetired(entry, at("2026-10-30"))).toBe(false);
    expect(isModelRetired(entry, at("2026-10-30", "23:59:59.999"))).toBe(false);
    expect(isModelRetired(entry, at("2026-10-31", "00:00:00.000"))).toBe(true);
    expect(isModelRetired(entry, at("2026-10-31"))).toBe(true);
    expect(isModelRetired(entry, at("2026-11-01"))).toBe(true);
    expect(isModelRetired(entry, at("2031-06-15"))).toBe(true);
  });

  test("the date is read in UTC, whatever offset the clock was written with", () => {
    // 01:00 on the 31st at UTC+2 is still the 30th in UTC.
    expect(isModelRetired(entry, new Date("2026-10-31T01:00:00+02:00"))).toBe(false);
    // 23:00 on the 30th at UTC-2 is already the 31st in UTC.
    expect(isModelRetired(entry, new Date("2026-10-30T23:00:00-02:00"))).toBe(true);
  });

  test.each([
    undefined, "", "soon", "2026-13-01", "2026-00-10", "2026-02-31", "2026-04-31", "2026-10-32",
    "2026-10-31T00:00:00Z", "10/31/2026", "20261031", "2026-1-5", " 2026-10-31", "2026-10-31 ",
  ])("no date or a malformed date (%j) never retires an entry", (retiresOn) => {
    expect(isModelRetired({ retiresOn }, at("9999-12-31"))).toBe(false);
  });

  test("a clock that is not a time retires nothing", () => {
    expect(isModelRetired(entry, new Date(Number.NaN))).toBe(false);
  });

  test("without a clock it reads the system time", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-10-30") });
    expect(isModelRetired(entry)).toBe(false);
    vi.setSystemTime(at("2026-10-31", "00:00:00.000"));
    expect(isModelRetired(entry)).toBe(true);
  });
});

describe("retiredBundledModel", () => {
  const model = "z-ai/glm-4.5";
  const retired = { model, retiredOn: "2026-12-31" };

  test("a bundled row is retired on its date and after, not the day before", () => {
    expect(retiredBundledModel("openrouter", model, at("2026-12-30", "23:59:59.999"))).toBeUndefined();
    expect(retiredBundledModel("openrouter", model, at("2026-12-31", "00:00:00.000"))).toEqual(retired);
    expect(retiredBundledModel("openrouter", model, at("2027-03-01"))).toEqual(retired);
  });

  test("the provider's live list wins over the bundled date", () => {
    recordLiveOpenRouterList("x-ai/grok-4.5", model);
    expect(retiredBundledModel("openrouter", model, at("2027-03-01"))).toBeUndefined();
    // A live list without the model does not vouch for it.
    recordLiveOpenRouterList("x-ai/grok-4.5");
    expect(retiredBundledModel("openrouter", model, at("2027-03-01"))).toEqual(retired);
  });

  test("only the row registered under exactly that id is retired", () => {
    const late = at("2027-03-01");
    // Spacing and letter case are not part of an id.
    expect(retiredBundledModel(" OpenRouter ", " Z-AI/GLM-4.5 ", late)).toEqual(retired);
    for (const neighbour of [
      "z-ai/glm-4.5:nitro", "z-ai/glm-4.5-air", "z-ai/glm-4", "glm-4.5", "vendor/z-ai/glm-4.5", "",
    ]) {
      expect(retiredBundledModel("openrouter", neighbour, late), neighbour).toBeUndefined();
    }
    // Z.AI's own glm-4.5 row carries no date, and no provider is no row.
    expect(findBundledModelCatalogEntry({ provider: "zai", model: "glm-4.5" })?.model).toBe("glm-4.5");
    expect(retiredBundledModel("zai", "glm-4.5", late)).toBeUndefined();
    expect(retiredBundledModel("openai", model, late)).toBeUndefined();
    expect(retiredBundledModel("", model, late)).toBeUndefined();
    expect(retiredBundledModel("not-a-provider", model, late)).toBeUndefined();
  });

  test("a row with no date is never retired", () => {
    expect(findBundledModelCatalogEntry({ provider: "openrouter", model: "x-ai/grok-4.5" })?.retiresOn).toBeUndefined();
    expect(retiredBundledModel("openrouter", "x-ai/grok-4.5", at("9999-12-31"))).toBeUndefined();
  });

  test("without a clock it reads the system time", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-12-30") });
    expect(retiredBundledModel("openrouter", model)).toBeUndefined();
    vi.setSystemTime(at("2026-12-31"));
    expect(retiredBundledModel("openrouter", model)).toEqual(retired);
  });
});

describe("findBundledModelCatalogEntry", () => {
  test("finds the bundled row by exact id and nothing else", () => {
    expect(findBundledModelCatalogEntry({ provider: "openrouter", model: "z-ai/glm-4.5" }))
      .toMatchObject({ provider: "openrouter", model: "z-ai/glm-4.5", retiresOn: "2026-12-31" });
    expect(findBundledModelCatalogEntry({ provider: "deepseek", model: " DeepSeek-Flash " })?.model).toBe("deepseek-flash");
    expect(findBundledModelCatalogEntry({ provider: "openrouter", model: "z-ai/glm-4.5:nitro" })).toBeUndefined();
    expect(findBundledModelCatalogEntry({ provider: "deepseek", model: "deepseek-flash-next" })).toBeUndefined();
    expect(findBundledModelCatalogEntry({ provider: undefined, model: "z-ai/glm-4.5" })).toBeUndefined();
    expect(findBundledModelCatalogEntry({ provider: "openrouter", model: undefined })).toBeUndefined();
    expect(findBundledModelCatalogEntry({ provider: "openrouter", model: "  " })).toBeUndefined();
  });

  test("a live row never stands in for the bundled one", () => {
    recordLiveOpenRouterList("acme/live-only");
    expect(findBundledModelCatalogEntry({ provider: "openrouter", model: "acme/live-only" })).toBeUndefined();
  });
});

describe("the bundled snapshot of 2026-10-20", () => {
  test("carries the nine dated rows issue #3447 lists", () => {
    const dated = REGISTERED_MODEL_CATALOG.filter((entry) => entry.retiresOn !== undefined)
      .map((entry) => [entry.provider, entry.model, entry.retiresOn]);
    expect(dated).toHaveLength(9);
    expect(dated).toEqual(expect.arrayContaining(
      [...RETIRED_BY_2026_11_12, ...RETIRING_2026_12_31].map(([model, date]) => ["openrouter", model, date]),
    ));
  });

  test("on 2026-11-12 seven of them are retired and the two dated 2026-12-31 are not", () => {
    const today = at("2026-11-12");
    for (const [model, retiredOn] of RETIRED_BY_2026_11_12) {
      expect(retiredBundledModel("openrouter", model, today), model).toEqual({ model, retiredOn });
    }
    for (const [model, retiredOn] of RETIRING_2026_12_31) {
      expect(retiredBundledModel("openrouter", model, today), model).toBeUndefined();
      expect(retiredBundledModel("openrouter", model, at("2026-12-31")), model).toEqual({ model, retiredOn });
    }
  });

  test("the day before the first date, no bundled row is retired", () => {
    const retired = REGISTERED_MODEL_CATALOG.filter((entry) =>
      retiredBundledModel(entry.provider, entry.model, at("2026-10-30")) !== undefined);
    expect(retired).toEqual([]);
  });
});
