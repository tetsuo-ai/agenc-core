import { describe, expect, it } from "vitest";

import { mergeConfigs, defaultConfig } from "../config/index.js";
import { StaticModelsManager } from "./models-manager.js";

describe("StaticModelsManager", () => {
  it("returns concrete metadata for known built-in models", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openai",
    });

    const info = await manager.getModelInfo("gpt-5");
    expect(info).toMatchObject({
      slug: "gpt-5",
      contextWindow: 1_000_000,
      effectiveContextWindowPercent: 95,
      defaultReasoningLevel: "medium",
      defaultReasoningSummary: "auto",
      truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    });
    expect(info.supportedReasoningLevels).toEqual(["low", "medium", "high"]);
  });

  it("lists configured provider default models alongside built-ins", async () => {
    const manager = new StaticModelsManager({
      config: mergeConfigs(defaultConfig(), {
        providers: {
          openrouter: {
            default_model: "anthropic/claude-3.7-sonnet",
          },
        },
      }),
      fallbackProvider: "openrouter",
    });

    const listed = await manager.listModels();
    expect(listed.map((entry) => entry.slug)).toContain(
      "anthropic/claude-3.7-sonnet",
    );
  });

  it("falls back cleanly for unknown slugs while preserving the active provider", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "groq",
    });

    const info = await manager.getModelInfo("custom-local-model");
    expect(info.slug).toBe("custom-local-model");
    expect(info.usedFallbackModelMetadata).toBe(true);
    expect(info.effectiveContextWindowPercent).toBe(100);
  });
});
