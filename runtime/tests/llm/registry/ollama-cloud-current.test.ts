import { afterEach, describe, expect, test } from "vitest";

import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import {
  OLLAMA_CLOUD_DEFAULT_MODEL,
  OLLAMA_CLOUD_RETIRED_ON,
  ollamaCloudCatalogEntry,
  parseOllamaCloudTags,
} from "../../../src/llm/registry/ollama-cloud-models.js";
import {
  clearPublishedModelCatalogs,
  recordPublishedModelCatalog,
} from "../../../src/llm/registry/published-model-catalog.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../../src/llm/registry/provider-info.js";
import { resolveProviderModelSelection } from "../../../src/session/provider-model-selection.js";

afterEach(() => clearPublishedModelCatalogs());

/**
 * Evidence, 2026-11-20: GET https://ollama.com/api/tags lists 24 models, 23 of
 * them chat models (clef:27b is a decision model). POST /api/show answers HTTP
 * 410 for each retired id below, "<model> was retired on November 9, 2026" or
 * "... on September 25, 2026".
 */
const RETIRED: Readonly<Record<string, string>> = {
  "deepseek-v4-flash:0731": "2026-09-25",
  "glm-5.1": "2026-09-25",
  "qwen3.5:397b": "2026-09-25",
  "minimax-m2.7": "2026-11-09",
  "mistral-large-3:675b": "2026-11-09",
  "nemotron-3-nano:30b": "2026-11-09",
};

const LIVE_CHAT_MODELS = [
  "minimax-m3.1-flash", "gpt-oss:20b", "muse-spark-open", "beam", "mimo-v2.6-flash", "minimax-m3",
  "nemotron-3-ultra", "glm-5.2", "deepseek-v4.1-flash", "gpt-oss:120b", "kimi-k2.6", "inkling-2-small",
  "deepseek-v4-pro:0813", "deepseek-v4.1-flash:1017", "mistral-large-4", "kimi-k2.7-code", "nemotron-3-super",
  "gemma4:31b", "mimo-v2.6-pro", "glm-5.3-flash", "kimi-k3", "kimi-k3.1-pro", "glm-5.3",
];

const NOW = { now: new Date("2026-11-20T12:00:00.000Z") };
const ON_DEEPSEEK = { provider: "deepseek", model: "deepseek-flash" };

describe("Ollama Cloud's bundled list", () => {
  test("offers every chat model Ollama serves and none it retired", () => {
    expect([...BUILT_IN_PROVIDER_MODEL_CATALOG["ollama-cloud"]].sort()).toEqual([...LIVE_CHAT_MODELS].sort());
    expect(OLLAMA_CLOUD_RETIRED_ON).toEqual(RETIRED);
  });

  test("defaults to a model Ollama serves", () => {
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS["ollama-cloud"]).toBe(OLLAMA_CLOUD_DEFAULT_MODEL);
    expect(LIVE_CHAT_MODELS).toContain(OLLAMA_CLOUD_DEFAULT_MODEL);
    expect(resolveProviderModelSelection({}, ON_DEEPSEEK, { model_provider: "ollama-cloud" }, {}, NOW))
      .toMatchObject({ provider: "ollama-cloud", model: OLLAMA_CLOUD_DEFAULT_MODEL });
  });

  test.each([
    // /api/show: model_info.<family>.context_length, capabilities, thinking.values and thinking.default.
    ["inkling-2-small", "Inkling 2 Small", ["none", "low", "medium", "high", "max"], "high"],
    ["kimi-k3.1-pro", "Kimi K3.1 Pro", ["none", "low", "medium", "high", "max"], "max"],
    ["mimo-v2.6-flash", "MiMo V2.6 Flash", ["none", "high"], "high"],
    ["mimo-v2.6-pro", "MiMo V2.6 Pro", ["none", "high"], "high"],
  ] as const)("gives %s its published contract", (model, label, efforts, defaultEffort) => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "ollama-cloud", model })).toMatchObject({
      model,
      displayName: label,
      contextWindow: 1_048_576,
      inputModalities: ["text", "image"],
      supportsToolUse: true,
      supportsThinking: true,
      supportedReasoningLevels: efforts,
      defaultReasoningLevel: defaultEffort,
      visibility: "list",
    });
    expect(resolveProviderModelSelection({}, ON_DEEPSEEK, { model_provider: "ollama-cloud", model }, {}, NOW))
      .toMatchObject({ provider: "ollama-cloud", model });
  });
});

describe("a retired Ollama Cloud model", () => {
  test.each(Object.entries(RETIRED))("%s is hidden, and refused with a plain message when chosen", (model, date) => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG["ollama-cloud"]).not.toContain(model);
    expect(resolveRegisteredModelCatalogEntry({ provider: "ollama-cloud", model }))
      .toMatchObject({ model, visibility: "none", retiresOn: date });
    expect(() => resolveProviderModelSelection({}, ON_DEEPSEEK, { model_provider: "ollama-cloud", model }, {}, NOW))
      .toThrow(new Error(`Ollama Cloud retired '${model}' on ${date}. Pick another model.`));
  });

  test("is refused while Ollama's live list, which no longer has it, is held", () => {
    const tags = { models: LIVE_CHAT_MODELS.map(model => ({ model, capabilities: ["completion", "tools"] })) };
    recordPublishedModelCatalog("ollama-cloud",
      parseOllamaCloudTags(tags).map((row, index) => ollamaCloudCatalogEntry(row, index)),
      { replace: true, readAt: NOW.now.getTime() });
    expect(() => resolveProviderModelSelection({}, ON_DEEPSEEK,
      { model_provider: "ollama-cloud", model: "minimax-m2.7" }, {}, NOW))
      .toThrow("Ollama Cloud retired 'minimax-m2.7' on 2026-11-09. Pick another model.");
  });
});
