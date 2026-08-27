import { describe, expect, it } from "vitest";

import { defaultConfig } from "../../config/schema.js";
import {
  getModelInstructions,
} from "../../context/personality-spec-instructions.js";
import { buildPrompt } from "../../session/run-turn.js";
import type { TurnContext } from "../../session/turn-context.js";
import { StaticModelsManager } from "../models-manager.js";
import {
  listRegisteredModelCatalogEntries,
  resolveModelCapabilityHints,
  resolveModelCatalogMetadata,
  resolveRegisteredModelCatalogEntry,
} from "./model-catalog.js";
import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  DEFAULT_BUILT_IN_PROVIDER_SELECTION,
  listBuiltInProviderInfo,
  resolveBuiltInProviderInfo,
} from "./provider-info.js";

const DONOR_MODEL_IDS = Object.freeze([
  // gpt-5 (the openai built-in default) is registered first so the default
  // resolves through the single-source registry rather than heuristic fallback.
  "gpt-5",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
  "gpt-5.2",
  "codex-auto-review", // branding-scan: allow OpenAI model identifier
]);

describe("LLM registry", () => {
  it("owns the default config provider and model as one registry selection", () => {
    expect(DEFAULT_BUILT_IN_PROVIDER_SELECTION).toEqual({
      provider: "grok",
      model: "grok-4.6",
    });
    expect(DEFAULT_BUILT_IN_PROVIDER_SELECTION.model).toBe(
      BUILT_IN_PROVIDER_DEFINITIONS[
        DEFAULT_BUILT_IN_PROVIDER_SELECTION.provider
      ].defaultModel,
    );
    expect(defaultConfig()).toMatchObject({
      model_provider: DEFAULT_BUILT_IN_PROVIDER_SELECTION.provider,
      model: DEFAULT_BUILT_IN_PROVIDER_SELECTION.model,
    });
  });

  it("lists built-in providers with request and auth metadata", () => {
    expect(resolveBuiltInProviderInfo("grok")).toMatchObject({
      id: "grok",
      name: "xAI Grok",
      defaultModel: "grok-4.6",
      credentials: {
        kind: "api-key",
        apiKey: {
          envVars: ["XAI_API_KEY", "GROK_API_KEY"],
          required: true,
        },
      },
    });

    expect(resolveBuiltInProviderInfo("agenc")).toMatchObject({
      id: "agenc",
      name: "AgenC",
      requiresManagedAuth: true,
    });
    expect(resolveBuiltInProviderInfo("anthropic")).toMatchObject({
      baseURL: "https://api.anthropic.com/v1",
    });
    expect(resolveBuiltInProviderInfo("amazon-bedrock")).toMatchObject({
      id: "amazon-bedrock",
      name: "Amazon Bedrock",
      defaultModel: "amazon.nova-pro-v1:0",
      baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
      credentials: {
        kind: "aws-sigv4",
        accessKeyId: {
          envVars: ["AWS_BEDROCK_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
          required: true,
        },
        secretAccessKey: {
          envVars: [
            "AWS_BEDROCK_SECRET_ACCESS_KEY",
            "AWS_SECRET_ACCESS_KEY",
          ],
          required: true,
        },
      },
    });
    expect(listBuiltInProviderInfo().map((entry) => entry.id)).toContain(
      "openai-compatible",
    );
  });

  it("resolves donor model catalog metadata by exact, prefix, and namespace", () => {
    expect(
      resolveRegisteredModelCatalogEntry({
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).toMatchObject({
      displayName: "gpt-5.4",
      priority: 2,
      defaultReasoningLevel: "xhigh",
    });

    expect(
      resolveModelCatalogMetadata({
        provider: "openai",
        model: "gpt-5.4-2026-02-01",
      }),
    ).toMatchObject({
      contextWindow: 272_000,
    });

    expect(
      resolveModelCatalogMetadata({
        provider: "openai",
        model: "preview/gpt-5.2",
      }),
    ).toMatchObject({
      contextWindow: 272_000,
    });

    expect(
      resolveModelCatalogMetadata({
        provider: "openai",
        model: "preview/gpt-5.4-2026-02-01",
      }),
    ).toMatchObject({
      contextWindow: 272_000,
    });
  });

  it("preserves the complete bundled donor model catalog shape", () => {
    const entries = listRegisteredModelCatalogEntries("openai");

    expect(entries.map((entry) => entry.model)).toEqual(DONOR_MODEL_IDS);
    for (const entry of entries) {
      expect(entry.supportedReasoningLevels).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(entry.supportsVerbosity).toBe(true);
      expect(entry.supportsParallelToolCalls).toBe(true);
      expect(entry.supportsReasoningSummaries).toBe(true);
    }
    expect(entries.find((entry) => entry.model === "gpt-5.4")).toMatchObject({
      maxContextWindow: 1_000_000,
      defaultReasoningLevel: "xhigh",
      additionalSpeedTiers: ["fast"],
    });
    expect(
      entries.find((entry) => entry.model === "codex-auto-review"), // branding-scan: allow OpenAI model identifier
    ).toMatchObject({
      displayName: "AgenC Auto Review",
      visibility: "hide",
      priority: 29,
    });
    const personalityModel = entries.find(
      (entry) => entry.model === "gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
    );
    expect(personalityModel?.modelMessages?.instructionsVariables).toMatchObject({
      personalityFriendly:
        "You optimize for team morale and being a supportive teammate as much as code quality.",
      personalityPragmatic:
        "You are a deeply pragmatic, effective software engineer.",
    });
    expect(
      getModelInstructions({
        modelInfo: personalityModel ?? {},
        baseInstructions: "base",
        personality: "pragmatic",
      }),
    ).toBe("You are a deeply pragmatic, effective software engineer.\n\nbase");
  });

  it("feeds catalog parallel-tool metadata into prompt shaping", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openai",
    });
    const modelInfo = await manager.getModelInfo("gpt-5.4");

    const prompt = buildPrompt(
      [{ role: "user", content: "hello" }],
      [],
      {
        modelInfo,
        dynamicTools: [],
      } as unknown as TurnContext,
      "Follow the local contract.",
    );

    expect(prompt.parallelToolCalls).toBe(true);
    expect(modelInfo.supportsPersonality).toBe(true);
  });

  it("exposes model capability hints from the bundled catalog", () => {
    expect(
      resolveModelCapabilityHints({
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).toMatchObject({
      supportsToolUse: true,
      supportsImageInput: true,
      supportsStructuredOutput: true,
      supportsStructuredOutputWithTools: true,
      supportsProviderNativeWebSearch: true,
      acceptsReasoningEffort: true,
    });
  });

});
