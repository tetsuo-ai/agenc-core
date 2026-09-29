import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/schema.js";
import { StaticModelsManager } from "../models-manager.js";
import { resolveRegisteredModelCatalogEntry } from "../registry/model-catalog.js";
import { BUILT_IN_PROVIDER_MODEL_CATALOG, BUILT_IN_PROVIDER_DEFAULT_MODELS } from "../registry/provider-info.js";
import { resolveReasoningEffort } from "../reasoning-effort.js";
import { getModelCosts } from "../../../src/utils/modelCost.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS } from "../../../src/session/cost.js";
import { resolveSessionReasoningEffort } from "../../../src/phases/stream-model.js";
import { buildAnthropicMessagesRequest } from "../wire/messages-anthropic.js";

// Verified with Anthropic's authenticated Models API and model overview
// pricing/capability pages on 2026-09-29.
describe("current Anthropic model catalog", () => {
  it.each([
    ["claude-sonnet-5-5", 1_000_000, 128_000, ["low", "medium", "high", "xhigh", "max"], "high"],
    ["claude-haiku-4-5-20251001", 200_000, 64_000, [], undefined],
  ])("offers %s with explicit verified metadata", async (model, contextWindow, outputLimit, levels, defaultLevel) => {
    const entry = resolveRegisteredModelCatalogEntry({ provider: "anthropic", model });
    expect(entry).toMatchObject({
      contextWindow, maxContextWindow: contextWindow,
      maxOutputTokens: 64_000, maxOutputTokensUpperLimit: outputLimit,
      inputModalities: ["text", "image"], supportsToolUse: true,
      supportsParallelToolCalls: true, supportsStructuredOutput: true,
      supportedReasoningLevels: levels, additionalSpeedTiers: [],
    });
    expect(entry?.defaultReasoningLevel).toBe(defaultLevel);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.anthropic).toContain(model);
    expect(resolveReasoningEffort({ provider: "anthropic", model }).levels).toEqual(levels);
    const manager = new StaticModelsManager({ config: defaultConfig(), fallbackProvider: "anthropic" });
    expect(await manager.getModelInfo(model)).toMatchObject({
      contextWindow, maxOutputTokensUpperLimit: outputLimit, supportedReasoningLevels: levels,
      usedFallbackModelMetadata: false,
    });
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.anthropic).toBe("claude-opus-5-5");
  });

  it("resolves the documented Haiku alias and keeps unknown Sonnet minors unregistered", () => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "anthropic", model: "claude-haiku-4-5" })?.model)
      .toBe("claude-haiku-4-5-20251001");
    expect(resolveRegisteredModelCatalogEntry({ provider: "anthropic", model: "claude-sonnet-5-50" }))
      .toBeUndefined();
  });

  it.each(["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5",
    "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"])(
    "replaces the conservative fallback for existing %s", async (model) => {
      const manager = new StaticModelsManager({ config: defaultConfig(), fallbackProvider: "anthropic" });
      const info = await manager.getModelInfo(model);
      expect(info).toMatchObject({ contextWindow: 1_000_000, maxOutputTokensUpperLimit: 128_000,
        usedFallbackModelMetadata: false });
      const effort = resolveSessionReasoningEffort("max", info.supportedReasoningLevels, { provider: "anthropic", model });
      expect(buildAnthropicMessagesRequest({ model, messages: [], tools: [], options: { reasoningEffort: effort } })
        .output_config).toEqual({ effort: "max" });
    },
  );

  it("carries Sonnet 5.5's explicit lowest thinking setting to the wire", () => {
    const model = "claude-sonnet-5-5";
    const reasoningEffort = resolveSessionReasoningEffort("none", [], { provider: "anthropic", model });
    expect(reasoningEffort).toBe("none");
    expect(buildAnthropicMessagesRequest({ model, messages: [], tools: [], options: { reasoningEffort } }).thinking)
      .toEqual({ type: "between_tools" });
  });

  it.each([
    ["claude-sonnet-5-5", 2, 10, 0.2, 2.5],
    ["claude-haiku-4-5-20251001", 1, 5, 0.1, 1.25],
    ["claude-fable-5-1", 10, 50, 0.25, 12.5],
    ["claude-fable-5", 10, 50, 1, 12.5],
  ])("prices %s consistently in both cost tables including caching", (model, input, output, read, write) => {
    const usage = {
      provider: "anthropic", model, inputTokens: 1_000_000, outputTokens: 1_000_000,
      cachedInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000,
      reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: 4_000_000, turns: 1,
    };
    const cost = computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS);
    expect(cost.known).toBe(true);
    expect(cost.costUsd).toBeCloseTo(input + output + read + write, 8);
    const legacyUsage = {
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    } as Parameters<typeof getModelCosts>[1];
    expect(getModelCosts(model as Parameters<typeof getModelCosts>[0], legacyUsage)).toMatchObject({
      inputTokens: input, outputTokens: output, promptCacheReadTokens: read, promptCacheWriteTokens: write,
    });
  });
});
