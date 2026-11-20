import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { readModelMenuSnapshot } from "../../../src/commands/model-menu-snapshot.js";
import { openRouterMenuCatalog } from "../../../src/commands/openrouter-menu-models.js";
import type { SlashCommandContext } from "../../../src/commands/types.js";
import { resolveHomeContext } from "../../../src/config/home.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { OPENROUTER_CATALOG_FALLBACK_NOTE } from "../../../src/llm/registry/openrouter-live-catalog.js";
import { OPENROUTER_MODEL_IDS } from "../../../src/llm/registry/openrouter-model-ids.js";
import { OPENROUTER_RETIRED_MODEL_CATALOG } from "../../../src/llm/registry/openrouter-retired-models.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../../src/llm/registry/provider-info.js";
import { clearPublishedModelCatalogs } from "../../../src/llm/registry/published-model-catalog.js";
import { recordPublishedModelCosts } from "../../../src/llm/registry/published-model-costs.js";
import { resolveProviderModelSelection } from "../../../src/session/provider-model-selection.js";

const homes: string[] = [];
afterEach(() => {
  clearPublishedModelCatalogs();
  recordPublishedModelCosts("openrouter", new Map());
  vi.restoreAllMocks();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

const NOW = { now: new Date("2026-11-20T12:00:00.000Z") };
const ON_DEEPSEEK = { provider: "deepseek", model: "deepseek-flash" };

/**
 * Evidence, 2026-11-20: GET https://openrouter.ai/api/v1/models lists 478
 * models, 415 with tools, 326 of them without a `:batch` variant: the
 * bundled snapshot. 33 ids of the 2026-10-20 snapshot are no longer listed.
 */
describe("OpenRouter's bundled list", () => {
  test("holds the listing's 326 tool models and defaults to one it lists", () => {
    expect(OPENROUTER_MODEL_IDS).toHaveLength(326);
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.openrouter).toBe("x-ai/grok-4.5");
    expect(OPENROUTER_MODEL_IDS).toContain("x-ai/grok-4.5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter[0]).toBe("x-ai/grok-4.5");
    // Every picker id is in the listing, Grok Build 0.1 (no longer listed) among none of them.
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter.every((model) => OPENROUTER_MODEL_IDS.includes(model))).toBe(true);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter).not.toContain("x-ai/grok-build-0.1");
  });

  test.each([
    ["openai/gpt-6.2-astra", 1_050_000, 128_000, ["max", "xhigh", "high", "medium", "low"], "medium"],
    ["openai/gpt-6.2-sol-pro", 1_050_000, 128_000, ["max", "xhigh", "high", "medium", "low"], "medium"],
    ["anthropic/claude-fable-5.2", 1_000_000, 128_000, ["max", "xhigh", "high", "medium", "low"], "high"],
    ["google/gemini-4-carbon", 1_048_576, 943_718, ["high", "medium", "low"], "medium"],
    ["google/gemini-4-hydrogen", 1_048_576, 943_718, ["xhigh", "high", "medium", "low"], "medium"],
    ["google/gemini-4-neon", 1_048_576, 943_718, ["xhigh", "high", "medium", "low"], "medium"],
    ["qwen/qwen4-max", 1_000_000, 131_072, ["xhigh", "high", "low", "none"], "high"],
    ["moonshotai/kimi-k3.1-pro", 1_048_576, 943_718, ["max", "high", "low", "none"], "max"],
  ] as const)("offers %s with the listing's window, output, efforts, image input and tools", (model, context, output, efforts, effort) => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter).toContain(model);
    const entry = resolveRegisteredModelCatalogEntry({ provider: "openrouter", model });
    expect(entry).toMatchObject({
      model, contextWindow: context, maxOutputTokens: output, supportsToolUse: true,
      supportedReasoningLevels: efforts, defaultReasoningLevel: effort, visibility: "list",
    });
    expect(entry?.inputModalities).toContain("image");
  });
});

describe("a model OpenRouter no longer lists", () => {
  test.each([
    ["openai/o4-mini", "2026-11-20"],
    ["x-ai/grok-build-0.1", "2026-11-20"],
    ["inception/mercury-3", "2026-11-20"],
    ["poolside/laguna-xs-2.1", "2026-10-31"],
    ["bytedance-seed/seed-1.6", "2026-11-11"],
  ])("%s is hidden and refused with its date, typed or saved", (model, date) => {
    const refusal = new Error(`OpenRouter retired '${model}' on ${date}. Pick another model.`);
    expect(OPENROUTER_MODEL_IDS).not.toContain(model);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter).not.toContain(model);
    expect(OPENROUTER_RETIRED_MODEL_CATALOG.find((entry) => entry.model === model))
      .toMatchObject({ provider: "openrouter", visibility: "none", retiresOn: date });
    // Typed.
    expect(() => resolveProviderModelSelection({}, ON_DEEPSEEK, { model_provider: "openrouter", model }, {}, NOW))
      .toThrow(refusal);
    // Saved as the OpenRouter model, then chosen again: the saved pair skips the
    // listing check, never the date.
    const saved = { model_provider: "openrouter", model };
    expect(() => resolveProviderModelSelection(saved, ON_DEEPSEEK, { model_provider: "openrouter" }, {}, NOW))
      .toThrow(refusal);
  });

  test("every row OpenRouter stopped listing is outside the bundled snapshot", () => {
    expect(OPENROUTER_RETIRED_MODEL_CATALOG).toHaveLength(33);
    for (const entry of OPENROUTER_RETIRED_MODEL_CATALOG) {
      expect(OPENROUTER_MODEL_IDS, entry.model).not.toContain(entry.model);
    }
  });
});

function context(environment: Record<string, string>): SlashCommandContext {
  const path = mkdtempSync(join(tmpdir(), "or-current-"));
  homes.push(path);
  const env = { AGENC_HOME: path, ...environment };
  return {
    argsRaw: "", cwd: path, home: path,
    session: {
      state: { unsafePeek: () => ({ sessionConfiguration: {
        provider: { slug: "openrouter" }, collaborationMode: { model: "x-ai/grok-4.5" },
      }, history: [] }) },
      activeTurn: { unsafePeek: () => null },
      setPendingProviderSwitch: vi.fn(),
      services: { providerEnvironment: env, configStore: {
        homeContext: resolveHomeContext(env, { platformHome: path }),
        current: () => ({ providers: { openrouter: { zero_data_retention: false } } }),
      } },
    },
  } as unknown as SlashCommandContext;
}

const listing = { data: ["x-ai/grok-4.5", "openai/gpt-6.2-astra", "vendor/live-only"].map((id) => ({
  id, name: id, context_length: 200_000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" },
})) };

describe("where the picker's OpenRouter list comes from", () => {
  test("with a key, OpenRouter's live list, read with that key", async () => {
    const ctx = context({ OPENROUTER_API_KEY: "fixture-only-key" });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(listing)));
    expect((await openRouterMenuCatalog(ctx, { fetchImpl }).refresh()).source).toBe("live");
    expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer fixture-only-key");
    const snapshot = readModelMenuSnapshot(ctx, NOW);
    expect(snapshot.providerCounts.openrouter).toBe(3);
    expect(snapshot.rows.filter((row) => row.provider === "openrouter").map((row) => row.displayModel))
      .toEqual(["x-ai/grok-4.5", "openai/gpt-6.2-astra", "vendor/live-only"]);
    expect(snapshot.catalogNote).not.toBe(OPENROUTER_CATALOG_FALLBACK_NOTE);
  });

  test("without a key and without an answer, the bundled list, said so", async () => {
    const ctx = context({});
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    expect((await openRouterMenuCatalog(ctx, { fetchImpl }).refresh()).source).toBe("bundled");
    expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).has("authorization")).toBe(false);
    const snapshot = readModelMenuSnapshot(ctx, NOW);
    expect(snapshot.providerCounts.openrouter).toBe(326);
    expect(snapshot.catalogNote).toBe(OPENROUTER_CATALOG_FALLBACK_NOTE);
  });
});

test("a model OpenRouter stopped listing resolves to its own dated row, not a neighbour's", () => {
  // openai/o4-mini-high would otherwise match a longer-lived openai/o4 row by prefix.
  for (const model of ["openai/o4-mini-high", "openai/o3-mini", "minimax/minimax-m2"]) {
    expect(resolveRegisteredModelCatalogEntry({ provider: "openrouter", model }))
      .toMatchObject({ model, visibility: "none", retiresOn: "2026-11-20" });
  }
});
