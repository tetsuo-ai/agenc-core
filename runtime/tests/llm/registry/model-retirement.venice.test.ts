import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

// The retirement rule is not OpenRouter's: every provider that fills in
// `retiresOn` gets it. Venice does, from `model_spec.deprecation`. Its real
// bundled snapshot has no dated model today, so this file bundles two: one
// ordinary model, and the provider's default with a later date.
vi.mock("../../../src/llm/registry/venice-models.data.json", () => {
  const row = (id: string, spec: Record<string, unknown>) => ({
    id, type: "text", object: "model", owned_by: "venice.ai",
    model_spec: {
      name: id, offline: false, privacy: "private", traits: [],
      availableContextTokens: 256000, maxCompletionTokens: 8192,
      pricing: { input: { usd: 1 }, output: { usd: 2 } },
      capabilities: { supportsFunctionCalling: true, supportsVision: false, supportsReasoning: false },
      ...spec,
    },
  });
  return {
    default: {
      data: [
        row("zai-org-glm-5-2", {
          traits: ["default", "function_calling_default"],
          deprecation: { autoRemap: false, removesAt: "2027-06-01T00:00:00.000Z" },
        }),
        row("venice-retiring", { deprecation: { autoRemap: false, removesAt: "2026-12-01T00:00:00.000Z" } }),
        row("venice-undated", { deprecation: { autoRemap: false, removesAt: "later this year" } }),
      ],
    },
  };
});

import type { SlashCommandContext } from "../../../src/commands/types.js";

// The suite's setup file has already loaded the real snapshot. Load the
// catalog and everything built on it again, over the one above.
vi.resetModules();
const { modelCapabilityTags } = await import("../../../src/commands/model-capability-tags.js");
const { readModelMenuSnapshot } = await import("../../../src/commands/model-menu-snapshot.js");
const { readProvidersHubModels } = await import("../../../src/commands/providers-hub-snapshot.js");
const { resolveHomeContext } = await import("../../../src/config/home.js");
const { assertModelCatalogSelection } = await import("../../../src/llm/model-catalog-selection.js");
const { findBundledModelCatalogEntry } = await import("../../../src/llm/registry/model-catalog.js");
const { retiredBundledModel } = await import("../../../src/llm/registry/model-retirement.js");
const { clearPublishedModelCatalogs, recordPublishedModelCatalog } =
  await import("../../../src/llm/registry/published-model-catalog.js");
const { VENICE_MODELS, veniceCatalogEntry } = await import("../../../src/llm/registry/venice-models.js");
const { resolveProviderModelSelection } = await import("../../../src/session/provider-model-selection.js");

const homes: string[] = [];
afterEach(() => {
  clearPublishedModelCatalogs();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

const at = (day: string, time = "12:00:00.000"): Date => new Date(`${day}T${time}Z`);
const MODEL = "venice-retiring";
const REFUSAL = "Venice AI retired 'venice-retiring' on 2026-12-01. Pick another model.";

/** A session on Grok with no Venice key: the picker reads Venice's bundled rows. */
function context(): SlashCommandContext {
  const path = mkdtempSync(join(tmpdir(), "venice-retirement-"));
  homes.push(path);
  const environment = { AGENC_HOME: path };
  return {
    argsRaw: "", cwd: path, home: path,
    session: {
      state: { unsafePeek: () => ({ sessionConfiguration: {
        provider: { slug: "grok" }, collaborationMode: { model: "grok-4.6" },
      }, history: [] }) },
      activeTurn: { unsafePeek: () => null },
      services: { providerEnvironment: environment, configStore: {
        homeContext: resolveHomeContext(environment, { platformHome: path }), current: () => ({}),
      } },
    },
  } as unknown as SlashCommandContext;
}

const offered = (now: Date): readonly string[] =>
  readModelMenuSnapshot(context(), { now }).rows
    .filter((row) => row.provider === "venice" && row.selectable)
    .map((row) => row.displayModel);

describe("a bundled Venice model with a removal date", () => {
  test("is registered with Venice's date", () => {
    expect(VENICE_MODELS.map((model) => model.model)).toEqual(["zai-org-glm-5-2", MODEL, "venice-undated"]);
    expect(findBundledModelCatalogEntry({ provider: "venice", model: MODEL })?.retiresOn).toBe("2026-12-01");
    expect(findBundledModelCatalogEntry({ provider: "venice", model: "venice-undated" })?.retiresOn).toBeUndefined();
  });

  test("the day before its date it is offered, tagged \"retires\" and selectable", () => {
    const before = at("2026-11-30", "23:59:59.999");
    expect(retiredBundledModel("venice", MODEL, before)).toBeUndefined();
    expect(offered(before)).toEqual(["zai-org-glm-5-2", MODEL, "venice-undated"]);
    expect(readProvidersHubModels(context(), "venice", { now: before }).find((row) => row.model === MODEL)?.tags)
      .toBe("retires 2026-12-01");
    expect(() => assertModelCatalogSelection({}, "venice", MODEL, {}, before)).not.toThrow();
  });

  test.each([
    ["on its date", at("2026-12-01", "00:00:00.000")],
    ["after its date", at("2027-02-01")],
  ])("%s it is not offered, is tagged \"retired\" and selection is refused with the date", (_when, now) => {
    expect(retiredBundledModel("venice", MODEL, now)).toEqual({ model: MODEL, retiredOn: "2026-12-01" });
    expect(offered(now)).toEqual(["zai-org-glm-5-2", "venice-undated"]);
    expect(readProvidersHubModels(context(), "venice", { now }).map((row) => row.model)).not.toContain(MODEL);
    expect(modelCapabilityTags("venice", MODEL, now)).toBe("retired 2026-12-01");
    expect(() => assertModelCatalogSelection({}, "venice", MODEL, {}, now)).toThrow(new Error(REFUSAL));
    expect(() => resolveProviderModelSelection({}, { provider: "grok", model: "grok-4.6" }, {
      model_provider: "venice", model: MODEL,
    }, {}, { now })).toThrow(new Error(REFUSAL));
    // Venice still takes any other id: its own list is the authority for those.
    expect(() => assertModelCatalogSelection({}, "venice", "venice-brand-new", {}, now)).not.toThrow();
    expect(() => assertModelCatalogSelection({}, "venice", "venice-undated", {}, now)).not.toThrow();
  });

  test("a provider default that is retired is not offered either, and the provider-only switch is refused", () => {
    const late = at("2027-06-01", "00:00:00.000");
    expect(offered(at("2027-05-31", "23:59:59.999"))).toEqual(["zai-org-glm-5-2", "venice-undated"]);
    expect(offered(late)).toEqual(["venice-undated"]);
    expect(() => resolveProviderModelSelection({}, { provider: "grok", model: "grok-4.6" }, {
      model_provider: "venice",
    }, {}, { now: late })).toThrow("Venice AI retired 'zai-org-glm-5-2' on 2027-06-01. Pick another model.");
    expect(resolveProviderModelSelection({}, { provider: "grok", model: "grok-4.6" }, {
      model_provider: "venice", model: "venice-undated",
    }, {}, { now: late })).toMatchObject({ provider: "venice", model: "venice-undated" });
  });

  test("Venice's live list wins: a model it still lists is accepted past the bundled date", () => {
    const late = at("2027-02-01");
    recordPublishedModelCatalog(
      "venice",
      VENICE_MODELS.map((model, priority) => veniceCatalogEntry(model, priority)),
      { replace: true },
    );
    expect(retiredBundledModel("venice", MODEL, late)).toBeUndefined();
    expect(offered(late)).toContain(MODEL);
    expect(() => assertModelCatalogSelection({}, "venice", MODEL, {}, late)).not.toThrow();
  });
});
