import { afterEach, describe, expect, test, vi } from "vitest";
import { modelCapabilityTags } from "../../src/commands/model-capability-tags.js";
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
/** The retirement tag among a model's tags, if it has one. */
const retirementTag = (provider: string, model: string, now?: Date): string | undefined =>
  modelCapabilityTags(provider, model, now).split(" · ").find((tag) => tag.startsWith("retire"));

describe("the retirement tag of a picker row", () => {
  // Bundled OpenRouter row dated 2026-12-31 (issue #3447).
  const model = "z-ai/glm-4.5";

  test("says \"retires\" until the date and \"retired\" from it on", () => {
    expect(retirementTag("openrouter", model, at("2026-10-20"))).toBe("retires 2026-12-31");
    expect(retirementTag("openrouter", model, at("2026-12-30", "23:59:59.999"))).toBe("retires 2026-12-31");
    expect(retirementTag("openrouter", model, at("2026-12-31", "00:00:00.000"))).toBe("retired 2026-12-31");
    expect(retirementTag("openrouter", model, at("2027-06-01"))).toBe("retired 2026-12-31");
    // The other tags do not move with the clock.
    expect(modelCapabilityTags("openrouter", model, at("2027-06-01")))
      .toBe(modelCapabilityTags("openrouter", model, at("2026-10-20")).replace("retires", "retired"));
  });

  test("is read against the system time when no clock is passed", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-12-30") });
    expect(retirementTag("openrouter", model)).toBe("retires 2026-12-31");
    vi.setSystemTime(at("2026-12-31"));
    expect(retirementTag("openrouter", model)).toBe("retired 2026-12-31");
  });

  test("is absent for a model with no date and for a model no catalog knows", () => {
    expect(retirementTag("openrouter", "x-ai/grok-4.5", at("9999-12-31"))).toBeUndefined();
    expect(modelCapabilityTags("openrouter", "not-in-any-catalog", at("9999-12-31"))).toBe("");
  });

  test("keeps reading \"retires\" for text that is not a date", () => {
    recordPublishedModelCatalog("openrouter", [openRouterCatalogEntry({
      model: "acme/undated", label: "Acme", modalities: ["text"], parameters: ["tools"], efforts: [], pricing: {},
      expires: "soon",
    }, 0)], { replace: true });
    expect(modelCapabilityTags("openrouter", "acme/undated", at("9999-12-31"))).toBe("tools · retires soon");
  });

  test("follows the provider's live row once its list is read", () => {
    const live = (expires?: string) => recordPublishedModelCatalog("openrouter", [openRouterCatalogEntry({
      model, label: model, modalities: ["text"], parameters: ["tools"], efforts: [], pricing: {},
      ...(expires === undefined ? {} : { expires }),
    }, 0)], { replace: true });
    // The provider moved the date: the bundled one no longer shows.
    live("2027-03-31");
    expect(modelCapabilityTags("openrouter", model, at("2027-01-15"))).toBe("tools · retires 2027-03-31");
    expect(modelCapabilityTags("openrouter", model, at("2027-03-31"))).toBe("tools · retired 2027-03-31");
    // The provider dropped the date.
    live();
    expect(modelCapabilityTags("openrouter", model, at("2027-06-01"))).toBe("tools");
  });
});
