import { describe, expect, it } from "vitest";

import {
  AgenCFeatureSet,
  experimentalFeatureSpecs,
  featureForKey,
  listBuiltInProviderInfo,
  resolveBuiltInProviderInfo,
  resolveModelCapabilityHints,
  resolveModelCatalogMetadata,
  resolveRegisteredModelCatalogEntry,
} from "./index.js";

describe("LLM registry", () => {
  it("lists built-in providers with request and auth metadata", () => {
    expect(resolveBuiltInProviderInfo("xai")).toMatchObject({
      id: "grok",
      name: "xAI Grok",
      defaultModel: "grok-4-fast",
      apiKeyEnvVar: "XAI_API_KEY",
      requestMaxRetries: 4,
      streamMaxRetries: 5,
      streamIdleTimeoutMs: 300_000,
      supportsWebsockets: false,
    });

    expect(resolveBuiltInProviderInfo("agenc")).toMatchObject({
      id: "agenc",
      name: "AgenC",
      requiresManagedAuth: true,
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
      displayName: "GPT-5.4",
      priority: 2,
      defaultReasoningLevel: "high",
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

  it("normalizes staged feature defaults and legacy keys", () => {
    const features = AgenCFeatureSet.fromConfig({
      include_apply_patch_tool: true,
      multi_agent_v2: true,
      unknown_feature: true,
    });

    expect(featureForKey("web_search")).toBe("web_search_request");
    expect(features.enabled("shell_tool")).toBe(true);
    expect(features.enabled("apply_patch_freeform")).toBe(true);
    expect(features.enabled("multi_agent_v2")).toBe(true);
    expect(features.enabled("multi_agent")).toBe(true);
    expect(experimentalFeatureSpecs().map((entry) => entry.key)).toContain(
      "goals",
    );
  });
});
