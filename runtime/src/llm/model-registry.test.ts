import { describe, expect, it } from "vitest";

import { defaultConfig } from "../config/index.js";
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
    expect(entry.capabilities.supportsStructuredOutput).toBe(true);
    expect(entry.capabilities.acceptsReasoningEffort).toBe(true);

    expect(modelRegistryEntryToModelInfo(entry)).toMatchObject({
      slug: "gpt-5",
      contextWindow: 1_000_000,
      supportedReasoningLevels: ["low", "medium", "high"],
      usedFallbackModelMetadata: false,
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
});
