import { describe, expect, it } from "vitest";

import { defaultConfig, mergeConfigs } from "../config/index.js";
import {
  ModelRegistry,
  modelRegistryEntryToModelInfo,
} from "./model-registry.js";

describe("ModelRegistry", () => {
  it("combines provider, metadata, cost, and capabilities for a model", () => {
    const registry = new ModelRegistry({ config: defaultConfig() });

    const entry = registry.resolveSync({
      provider: "openai",
      model: "gpt-5",
    });

    expect(entry.provider).toBe("openai");
    expect(entry.model).toBe("gpt-5");
    expect(entry.metadata.contextWindow).toBe(1_000_000);
    expect(entry.cost.known).toBe(true);
    expect(entry.cost.matchedKey).toBe("openai:gpt-5");
    expect(entry.capabilities.supportsToolUse).toBe(true);
    expect(entry.capabilities.supportsVisionInput).toBe(true);
    expect(entry.capabilities.supportsStructuredOutput).toBe(true);
    expect(entry.capabilities.acceptsReasoningEffort).toBe(true);
    expect(entry.capabilities.supportsProviderNativeWebSearch).toBe(false);

    expect(modelRegistryEntryToModelInfo(entry)).toMatchObject({
      slug: "gpt-5",
      contextWindow: 1_000_000,
      supportedReasoningLevels: ["low", "medium", "high"],
      usedFallbackModelMetadata: false,
    });
  });

  it("uses the registered model catalog for newer OpenAI model metadata", () => {
    const registry = new ModelRegistry({ config: defaultConfig() });

    const entry = registry.resolveSync({
      provider: "openai",
      model: "gpt-5.4",
    });

    expect(entry.metadata.contextWindow).toBe(272_000);
    expect(entry.capabilities.supportsProviderNativeWebSearch).toBe(true);
    expect(modelRegistryEntryToModelInfo(entry)).toMatchObject({
      slug: "gpt-5.4",
      defaultReasoningLevel: "xhigh",
      defaultReasoningSummary: "none",
      supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
    });
  });

  it("preserves hidden model visibility in model info", () => {
    const registry = new ModelRegistry({ config: defaultConfig() });

    const entry = registry.resolveSync({
      provider: "openai",
      model: "codex-auto-review", // branding-scan: allow OpenAI model identifier
    });

    expect(modelRegistryEntryToModelInfo(entry)).toMatchObject({
      slug: "codex-auto-review", // branding-scan: allow OpenAI model identifier
      visibility: "hide",
      showInPicker: false,
    });
  });

  it("keeps local provider costs free while preserving conservative metadata", () => {
    const registry = new ModelRegistry({ config: defaultConfig() });

    const entry = registry.resolveSync({
      provider: "lmstudio",
      model: "unknown-local-model",
    });

    expect(entry.cost.known).toBe(true);
    expect(entry.cost.matchedKey).toBe("lmstudio");
    expect(entry.cost.entry.inputUsdPer1K).toBe(0);
    expect(entry.cost.entry.outputUsdPer1K).toBe(0);
    expect(entry.metadata.usedFallbackModelMetadata).toBe(true);
    expect(entry.capabilities.supportsStructuredOutput).toBe(false);
  });

  it("exposes tool, vision, structured-output, and native web-search capability dimensions", () => {
    const registry = new ModelRegistry({ config: defaultConfig() });

    const entry = registry.resolveSync({
      provider: "grok",
      model: "grok-4-fast",
    });

    expect(entry.capabilities).toMatchObject({
      supportsToolUse: true,
      supportsVisionInput: true,
      supportsStructuredOutput: true,
      supportsProviderNativeWebSearch: true,
    });

    expect(
      registry.resolveSync({
        provider: "grok",
        model: "grok-code-fast-1",
      }).capabilities.supportsProviderNativeWebSearch,
    ).toBe(false);
  });

  it("normalizes provider-qualified aliases at the registry boundary", () => {
    const registry = new ModelRegistry({ config: defaultConfig() });

    expect(registry.resolveSelection("custom:local-model", "grok")).toEqual({
      provider: "openai-compatible",
      model: "local-model",
    });

    const entry = registry.resolveSync({
      provider: "openai_compatible",
      model: "local-model",
    });
    expect(entry.provider).toBe("openai-compatible");
    expect(entry.capabilities.provider).toBe("openai-compatible");
    expect(entry.cost.known).toBe(true);
    expect(entry.cost.matchedKey).toBe("openai-compatible");
  });

  it("preserves unknown-cost fallback without hiding registry misses", () => {
    const registry = new ModelRegistry({
      config: defaultConfig(),
      costRegistry: {},
    });

    const entry = registry.resolveSync({
      provider: "openai",
      model: "unpriced-model",
    });

    expect(entry.cost.known).toBe(false);
    expect(entry.cost.matchedKey).toBeUndefined();
    expect(entry.cost.entry.label).toBe("fallback");
  });

  it("applies configured capability overrides through registry entries", () => {
    const registry = new ModelRegistry({
      config: mergeConfigs(defaultConfig(), {
        providers: {
          openrouter: {
            default_model: "openai/gpt-5",
            capability_overrides: {
              acceptsReasoningEffort: true,
              supportsImageInput: true,
            },
          },
        },
      }),
    });

    const entry = registry.resolveSync({
      provider: "openrouter",
      model: "openai/gpt-5",
    });

    expect(entry.capabilities.acceptsReasoningEffort).toBe(true);
    expect(entry.capabilities.supportsImageInput).toBe(true);
    expect(entry.capabilities.supportsVisionInput).toBe(true);
  });
});
