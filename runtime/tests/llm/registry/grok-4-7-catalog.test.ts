import { describe, expect, it } from "vitest";
import { deriveFlatCatalog, resolveRegisteredModelCatalogEntry } from "../registry/model-catalog.js";
import { BUILT_IN_PROVIDER_MODEL_CATALOG, BUILT_IN_PROVIDER_DEFAULT_MODELS } from "../registry/provider-info.js";
import { getContextWindowForModel } from "../../utils/context.js";
import { resolveContextWindowProfile } from "../_deps/context-window.js";
import { getProviderNativeToolDefinitions } from "../provider-native-search.js";

describe("Grok 4.7 documented catalog", () => {
  it("resolves its own entry, context and effort without changing the default", async () => {
    const entry = resolveRegisteredModelCatalogEntry({ provider: "grok", model: "grok-4.7" });
    expect(entry).toMatchObject({ model: "grok-4.7", displayName: "Grok 4.7", contextWindow: 500_000,
      maxContextWindow: 500_000, inputModalities: ["text", "image"], supportsToolUse: true,
      supportsParallelToolCalls: true, supportsStructuredOutput: true, supportsSearchTool: true,
      webSearchToolType: "none", supportsVerbosity: false, supportsReasoningSummaries: false,
      supportedReasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "high",
      additionalSpeedTiers: [], visibility: "list" });
    expect(entry?.maxOutputTokens).toBeUndefined();
    expect(entry?.maxOutputTokensUpperLimit).toBeUndefined();
    expect(getContextWindowForModel("grok-4.7")).toBe(500_000);
    expect((await resolveContextWindowProfile({ provider: "grok", model: "grok-4.7" }))?.contextWindowTokens).toBe(500_000);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.grok).toContain("grok-4.7");
    expect(deriveFlatCatalog().grok?.slice(0, 2)).toEqual(["grok-4.7", "grok-4.6"]);
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.grok).toBe("grok-4.6");
  });
  it("uses xAI native tool payloads for search and code execution", () => {
    expect(getProviderNativeToolDefinitions({ provider: "grok", model: "grok-4.7",
      webSearch: true, xSearch: true, codeExecution: true }).map(tool => tool.payload.type))
      .toEqual(["web_search", "x_search", "code_interpreter"]);
  });
});
