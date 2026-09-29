import { describe, expect, test } from "vitest";
import { BUILT_IN_PROVIDER_DEFAULT_MODELS, BUILT_IN_PROVIDER_MODEL_CATALOG } from "./provider-info.js";
import { resolveRegisteredModelCatalogEntry } from "./model-catalog.js";
import { BEDROCK_CONVERSE_MODELS } from "./bedrock-converse-models.js";
import { resolveProviderCapabilityEntry } from "../capabilities.js";
import { DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../../session/cost.js";

describe("documented providers without live credentials", () => {
  test("uses a current shared Groq default and provider-specific rates", () => {
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.groq).toBe("openai/gpt-oss-120b");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.groq).toEqual([
      "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b", "minimaxai/minimax-m2.7",
    ]);
    expect(resolveModelCostEntry({ provider: "groq", model: "openai/gpt-oss-120b" }, DEFAULT_MODEL_COSTS)?.entry)
      .toMatchObject({ inputUsdPer1K: 0.00015, outputUsdPer1K: 0.0006 });
    for (const model of ["minimaxai/minimax-m2.7", "llama-3.3-70b-versatile"]) {
      expect(resolveModelCostEntry({ provider: "groq", model }, DEFAULT_MODEL_COSTS)).toBeNull();
    }
    expect(resolveProviderCapabilityEntry({ provider: "groq", model: "qwen/qwen3.8-27b" }))
      .toMatchObject({ supportsImageInput: true, supportsToolUse: true });
  });
  test("keeps dedicated Cerebras metadata while hiding its retired shared row", () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.cerebras).toEqual(["gpt-oss-120b", "qwen-3.8-27b"]);
    expect(resolveRegisteredModelCatalogEntry({ provider: "cerebras", model: "gemma-4-31b" }))
      .toMatchObject({ visibility: "none", supportsToolUse: true });
  });
  test("adds the documented Copilot ID and excludes retired entries", () => {
    for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "claude-opus-5.5"]) {
      expect(BUILT_IN_PROVIDER_MODEL_CATALOG.github).toContain(`github:copilot:${model}`);
      const cost = resolveModelCostEntry({ provider: "github", model }, DEFAULT_MODEL_COSTS);
      expect(cost?.key).toBe(`github:${model}`);
      expect(cost?.entry.fastMode).toBeUndefined();
      expect(cost?.entry.webSearchUsdPerRequest).toBeUndefined();
    }
    expect(resolveModelCostEntry({ provider: "github", model: "gpt-6-astra" }, DEFAULT_MODEL_COSTS)?.entry)
      .toMatchObject({ inputUsdPer1K: 0.01, outputUsdPer1K: 0.05,
        longContext: { aboveInputTokens: 272_000, rates: { inputUsdPer1K: 0.02, outputUsdPer1K: 0.075 } } });
    for (const model of ["claude-opus-4.5", "claude-opus-4.6", "claude-sonnet-4.5", "gemini-3.1-pro-preview", "mai-code-1-flash-picker", "raptor-mini"]) {
      expect(BUILT_IN_PROVIDER_MODEL_CATALOG.github).not.toContain(`github:copilot:${model}`);
    }
  });
  test.each(BEDROCK_CONVERSE_MODELS)("keeps literal Bedrock $model text/tool contracts without guessed limits", ({ model }) => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG["amazon-bedrock"]).toContain(model);
    expect(resolveRegisteredModelCatalogEntry({ provider: "amazon-bedrock", model })?.visibility).toBe("list");
    expect(resolveProviderCapabilityEntry({ provider: "amazon-bedrock", model }))
      .toMatchObject({ supportsToolUse: true, supportsImageInput: false });
    if (!model.startsWith("anthropic.")) {
      const entry = resolveRegisteredModelCatalogEntry({ provider: "amazon-bedrock", model });
      expect(entry?.contextWindow).toBeUndefined();
      expect(entry?.supportedReasoningLevels).toEqual([]);
      expect(resolveRegisteredModelCatalogEntry({ provider: "amazon-bedrock", model: `${model}-unknown-variant` })).toBeUndefined();
    }
  });
});
