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
 *   (c) the provider-neutral /model catalog.
 *   (d) the grok adapter context-window resolver (resolveContextWindowProfile)
 *       AND the TUI resolver (getContextWindowForModel).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultConfig } from "../../../src/config/schema.js";
import { buildProviderModelCatalog } from "../../../src/config/provider-model-authority.js";
import { StaticModelsManager } from "../../../src/llm/models-manager.js";
import {
  deriveFlatCatalog,
  listRegisteredModelCatalogEntries,
  resolveModelCatalogMetadata,
  resolveRegisteredModelCatalogEntry,
} from "../../../src/llm/registry/model-catalog.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
  providerLocalModelIdFromCatalog,
  type BuiltInProviderSlug,
} from "../../../src/llm/registry/provider-info.js";
import { resolveContextWindowProfile } from "../../../src/llm/_deps/context-window.js";
import { getContextWindowForModel } from "../../../src/utils/context.js";
import {
  resetModelStringsForTestingOnly,
  setInitialMainLoopModel,
} from "../../../src/bootstrap/state.js";

const NEW_MODEL = "grok-build-0.1";
const GROK_45 = "grok-4.5";
const ONE_MILLION = 1_000_000;

const TOUCHED_ENV_KEYS = [
  "AGENC_HOME",
  "AGENC_PROVIDER",
  "AGENC_MAX_CONTEXT_TOKENS",
  "XAI_API_KEY",
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of TOUCHED_ENV_KEYS) {
    ORIGINAL_ENV[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AGENC_PROVIDER = "grok";
  process.env.XAI_API_KEY = "xai-test-key";
  setInitialMainLoopModel(null);
  resetModelStringsForTestingOnly();
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
  resetModelStringsForTestingOnly();
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

  it("(c) shows grok-build-0.1 in the provider-neutral /model catalog", () => {
    const options = buildProviderModelCatalog(defaultConfig()).grok ?? [];
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

describe("retired models remain historical metadata, not live choices", () => {
  it("uses only reachable provider defaults and catalog rows", () => {
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.deepseek).toBe("deepseek-flash");
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.mistral).toBe("mistral-medium-latest");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.deepseek).toEqual([
      "deepseek-flash",
      "deepseek-v4-pro",
    ]);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.groq).not.toContain(
      "mixtral-8x7b-32768",
    );
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.mistral).toEqual([
      "mistral-medium-latest", "mistral-small-latest", "codestral-latest",
      "ministral-14b-latest", "ministral-8b-latest", "ministral-3b-latest",
      "voxtral-small-latest", "labs-leanstral-1-5",
      "mistral-large-latest", "zai-glm-5-3", "zai-glm-5-2",
    ]);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.minimax).toContain("MiniMax-M3");
  });

  it("does not offer retired Opus 4.1 or ABAB rows in model menus", () => {
    const catalog = buildProviderModelCatalog(defaultConfig());
    expect(catalog.anthropic).not.toContain("claude-opus-4-1");
    const minimaxValues = catalog.minimax ?? [];
    expect(minimaxValues).toContain("MiniMax-M3");
    expect(minimaxValues.some((value) => value.startsWith("abab"))).toBe(false);
  });
});

describe("canonical provider catalogs preserve supported selection rows", () => {
  it("keeps Copilot Claude identifiers out of the native Anthropic catalog", () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.anthropic).toContain("claude-opus-5-5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.anthropic).not.toContain("claude-opus-5.5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.github).toContain("github:copilot:claude-opus-5.5");
  });

  it("contains no duplicate raw or provider-local rows", () => {
    for (const [provider, models] of Object.entries(
      BUILT_IN_PROVIDER_MODEL_CATALOG,
    )) {
      expect(new Set(models), `${provider}: raw IDs`).toHaveLength(
        models.length,
      );
      const localModels = models.map((model) =>
        providerLocalModelIdFromCatalog(
          provider as BuiltInProviderSlug,
          model,
        ),
      );
      expect(new Set(localModels), `${provider}: local IDs`).toHaveLength(
        localModels.length,
      );
    }
  });

  it("keeps the complete unique NVIDIA NIM selection surface", () => {
    const models = BUILT_IN_PROVIDER_MODEL_CATALOG["nvidia-nim"];
    // 115 ids until 2026-10-17, when GET /v1/models stopped listing 80 of them (end of life, HTTP
    // 410, or gone, HTTP 404). The 35 NVIDIA still lists are the complete surface; the retired
    // ids are pinned in nvidia-nim-catalog.test.ts.
    expect(models).toHaveLength(35);
    expect(new Set(models)).toHaveLength(35);
    expect(models).toEqual(
      expect.arrayContaining([
        "nvidia/cosmos-reason2-8b",
        "meta/codellama-70b",
        "nvidia/nemotron-3-super-120b-a12b",
        "nvidia/llama3-chatqa-1.5-70b",
        "meta/llama-3.2-90b-vision-instruct",
        "google/gemma-4-31b-it",
        "mistralai/mistral-large",
        "ibm/granite-3.0-8b-instruct",
        "databricks/dbrx-instruct",
        "writer/palmyra-med-70b-32k",
        "moonshotai/kimi-k2.6",
        "meta/muse-glimmer-30b",
        "openai/gpt-oss-20b",
      ]),
    );
    expect(models).not.toContain("openai/gpt-oss-120b");
    expect(buildProviderModelCatalog(defaultConfig())["nvidia-nim"]).toEqual(
      models,
    );
  });

  it("gives GPT-5 the effort ladder its API accepts and keeps xhigh for the later generations", () => {
    // Probed on the Responses API 2026-09-11: gpt-5 rejects xhigh
    // ("Supported values are: minimal, low, medium, high"); gpt-5.5 and
    // gpt-5.4 accept xhigh and reject max; gpt-5.3-codex rejects minimal.
    expect(
      resolveRegisteredModelCatalogEntry({ provider: "openai", model: "gpt-5" })
        ?.supportedReasoningLevels,
    ).toEqual(["minimal", "low", "medium", "high"]);
    for (const model of ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2"]) {
      const levels = resolveRegisteredModelCatalogEntry({ provider: "openai", model })
        ?.supportedReasoningLevels;
      expect(levels, model).toContain("xhigh");
      expect(levels, model).not.toContain("minimal");
      expect(levels, model).not.toContain("max");
    }
  });

  it("keeps every supported MiniMax generation in one catalog", () => {
    const models = BUILT_IN_PROVIDER_MODEL_CATALOG.minimax;
    // The lineup MiniMax documents for its OpenAI-compatible route
    // (platform.minimax.io, 2026-09-11), newest first.
    expect(models).toEqual([
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
    ]);
    expect(new Set(models)).toHaveLength(models.length);
    expect(buildProviderModelCatalog(defaultConfig()).minimax).toEqual(models);
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
    // grok-4.6 now leads the grok list; 4.5 stays catalogued right behind it
    // with its own official context and reasoning controls, which is what this
    // case is about.
    expect(deriveFlatCatalog().grok).toContain(GROK_45);
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
