/**
 * Single-source-of-truth (SoT) unification tests.
 *
 * These assert the core promise of the model-catalog refactor: adding ONE
 * entry to REGISTERED_MODEL_CATALOG (here, grok-build-0.1) surfaces that model
 * in EVERY consumer with no other file touched, and that the previously
 * duplicated grok-4.3 context-window tables now agree (1M everywhere).
 *
 * Consumers proven:
 *   (a) the registry / ModelsManager.listModels (also feeds spawn_agent's
 *       validateSpawnModelOverrides + buildSpawnModelSchema, which both read
 *       from modelsManager.listModels()/getModelInfo()).
 *   (b) spawn_agent validation surface: membership in listModels() +
 *       supportedReasoningLevels from getModelInfo().
 *   (c) the /model picker (getModelOptions when the provider is xai).
 *   (d) the grok adapter context-window resolver (resolveContextWindowProfile)
 *       AND the TUI resolver (getContextWindowForModel).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultConfig } from "../../../src/config/schema.js";
import { StaticModelsManager } from "../../../src/llm/models-manager.js";
import {
  deriveFlatCatalog,
  listRegisteredModelCatalogEntries,
  resolveModelCatalogMetadata,
} from "../../../src/llm/registry/model-catalog.js";
import { BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../../src/llm/registry/provider-info.js";
import { resolveContextWindowProfile } from "../../../src/llm/_deps/context-window.js";
import { getContextWindowForModel } from "../../../src/utils/context.js";
import { getModelOptions } from "../../../src/utils/model/modelOptions.js";
import {
  resetModelStringsForTestingOnly,
  setInitialMainLoopModel,
  setMainLoopModelOverride,
} from "../../../src/bootstrap/state.js";
import { resetSettingsCache } from "../../../src/utils/settings/settingsCache.js";

const NEW_MODEL = "grok-build-0.1";
const GROK_45 = "grok-4.5";
const ONE_MILLION = 1_000_000;

const TOUCHED_ENV_KEYS = [
  "AGENC_CONFIG_DIR",
  "AGENC_HOME",
  "AGENC_USE_OPENAI",
  "AGENC_USE_GEMINI",
  "AGENC_USE_GITHUB",
  "AGENC_USE_MISTRAL",
  "AGENC_MAX_CONTEXT_TOKENS",
  "USER_TYPE",
  "XAI_API_KEY",
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of TOUCHED_ENV_KEYS) {
    ORIGINAL_ENV[key] = process.env[key];
    delete process.env[key];
  }
  process.env.XAI_API_KEY = "xai-test-key";
  setInitialMainLoopModel(null);
  setMainLoopModelOverride(undefined);
  resetModelStringsForTestingOnly();
  resetSettingsCache();
});

afterEach(() => {
  for (const key of TOUCHED_ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  setInitialMainLoopModel(null);
  setMainLoopModelOverride(undefined);
  resetModelStringsForTestingOnly();
  resetSettingsCache();
});

describe("model SoT: one catalog entry surfaces everywhere", () => {
  it("registers grok-build-0.1 once in REGISTERED_MODEL_CATALOG", () => {
    const entry = listRegisteredModelCatalogEntries("grok").find(
      (candidate) => candidate.model === NEW_MODEL,
    );
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      provider: "grok",
      displayName: "Grok Build 0.1",
      contextWindow: ONE_MILLION,
      maxContextWindow: ONE_MILLION,
      supportsToolUse: true,
      visibility: "list",
    });
    expect(entry?.supportedReasoningLevels).toEqual([]);
  });

  it("derives the flat provider catalog from the registry", () => {
    // The flat catalog (and BUILT_IN_PROVIDER_MODEL_CATALOG) is computed from
    // the registry, so the new entry appears with no separate edit.
    expect(deriveFlatCatalog().grok).toContain(NEW_MODEL);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.grok).toContain(NEW_MODEL);
    // It remains ahead of the legacy catalog rows; Grok 4.5 now leads.
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.grok.indexOf(NEW_MODEL)).toBeLessThan(
      BUILT_IN_PROVIDER_MODEL_CATALOG.grok.indexOf("grok-4.3"),
    );
  });

  it("(a)+(b) lists grok-build-0.1 via ModelsManager (spawn_agent surface)", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "grok",
    });

    const slugs = (await manager.listModels()).map((model) => model.slug);
    // tryListModels() feeds buildSpawnModelSchema; listModels() feeds
    // validateSpawnModelOverrides. Both must include the new model.
    expect(slugs).toContain(NEW_MODEL);
    expect(
      (manager.tryListModels() ?? []).map((model) => model.slug),
    ).toContain(NEW_MODEL);

    const info = await manager.getModelInfo(NEW_MODEL);
    expect(info.slug).toBe(NEW_MODEL);
    expect(info.contextWindow).toBe(ONE_MILLION);
    // spawn_agent rejects reasoning_effort for models without supported levels.
    expect(info.supportedReasoningLevels).toEqual([]);
  });

  it("(c) shows grok-build-0.1 in the /model picker for xai", () => {
    const options = getModelOptions(false).map((option) => option.value);
    expect(options).toContain(NEW_MODEL);
  });

  it("(d) resolves grok-build-0.1 to 1M via BOTH context-window resolvers", async () => {
    const adapter = await resolveContextWindowProfile({
      provider: "grok",
      model: NEW_MODEL,
    });
    expect(adapter?.contextWindowTokens).toBe(ONE_MILLION);
    expect(getContextWindowForModel(NEW_MODEL)).toBe(ONE_MILLION);
  });
});

describe("model SoT: grok-4.3 context window is consistent (1M everywhere)", () => {
  it("agrees across the grok adapter path and the TUI path", async () => {
    const adapter = await resolveContextWindowProfile({
      provider: "grok",
      model: "grok-4.3",
    });
    expect(adapter?.contextWindowTokens).toBe(ONE_MILLION);
    expect(getContextWindowForModel("grok-4.3")).toBe(ONE_MILLION);
    expect(
      resolveModelCatalogMetadata({ provider: "grok", model: "grok-4.3" })
        ?.contextWindow,
    ).toBe(ONE_MILLION);
  });

  it("preserves grok-4.20 family context windows (2M) and reasoning gating", async () => {
    for (const model of [
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent-0309",
    ]) {
      const adapter = await resolveContextWindowProfile({
        provider: "grok",
        model,
      });
      expect(adapter?.contextWindowTokens).toBe(2_000_000);
      expect(getContextWindowForModel(model)).toBe(2_000_000);
    }

    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "grok",
    });
    // Only the multi-agent variant accepts reasoning_effort.
    expect(
      (await manager.getModelInfo("grok-4.20-multi-agent-0309"))
        .supportedReasoningLevels,
    ).toEqual(["low", "medium", "high"]);
    expect(
      (await manager.getModelInfo("grok-4.20-0309-reasoning"))
        .supportedReasoningLevels,
    ).toEqual([]);
  });
});

describe("model SoT: grok-4.5", () => {
  it("is listed with its official context and reasoning controls", async () => {
    expect(deriveFlatCatalog().grok[0]).toBe(GROK_45);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.grok).toContain(GROK_45);

    const adapter = await resolveContextWindowProfile({
      provider: "grok",
      model: GROK_45,
    });
    expect(adapter?.contextWindowTokens).toBe(500_000);
    expect(getContextWindowForModel(GROK_45)).toBe(500_000);

    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "grok",
    });
    expect(await manager.getModelInfo(GROK_45)).toMatchObject({
      slug: GROK_45,
      contextWindow: 500_000,
      supportedReasoningLevels: ["low", "medium", "high"],
      defaultReasoningLevel: "high",
      showInPicker: true,
    });
  });
});
