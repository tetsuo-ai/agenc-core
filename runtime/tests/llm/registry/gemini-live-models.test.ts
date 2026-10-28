import { afterEach, describe, expect, test, vi } from "vitest";

import { assertModelCatalogSelection } from "../../../src/llm/model-catalog-selection.js";
import { ModelMetadataResolver } from "../../../src/llm/model-metadata.js";
import { GeminiProvider } from "../../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../../src/llm/providers/gemini/endpoint-plan.js";
import { resolveProviderModelCapabilities } from "../../../src/llm/capabilities.js";
import {
  geminiLiveCatalogEntry,
  looksLikeGeminiChatModelId,
  parseGeminiLiveModels,
} from "../../../src/llm/registry/gemini-live-models.js";
import { resolveGeminiReasoningEffort } from "../../../src/llm/registry/gemini-thinking-models.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { clearPublishedModelCatalogs } from "../../../src/llm/registry/published-model-catalog.js";
import {
  computeUsdCostWithResolution,
  DEFAULT_MODEL_COSTS,
  resolveModelCostEntry,
} from "../../../src/session/cost.js";

// Rows from GET /v1beta/models on 2026-10-28 with the project key, trimmed to
// one model of each kind, plus one fictional model ("gemini-4-futura-preview")
// standing in for a model Google ships after this Core release.
const FUTURE = "gemini-4-futura-preview";
const LIVE_LIST = {
  models: [
    { name: "models/gemini-4-argon", displayName: "Gemini 4 Argon", inputTokenLimit: 1_048_576, outputTokenLimit: 32_768, supportedGenerationMethods: ["generateContent", "countTokens", "batchGenerateContent"], thinking: true },
    { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent", "countTokens", "createCachedContent", "batchGenerateContent"], thinking: true },
    { name: "models/gemini-3.1-flash-lite-preview", displayName: "Gemini 3.1 Flash Lite Preview", inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent", "countTokens", "createCachedContent", "batchGenerateContent"], thinking: true },
    { name: `models/${FUTURE}`, displayName: "Gemini 4 Futura Preview", inputTokenLimit: 2_097_152, outputTokenLimit: 32_768, supportedGenerationMethods: ["generateContent", "countTokens"], thinking: true },
    { name: "models/gemini-3.8-flash-tts", displayName: "Gemini 3.8 Flash TTS", inputTokenLimit: 8_192, outputTokenLimit: 16_384, supportedGenerationMethods: ["generateContent", "countTokens", "batchGenerateContent"] },
    { name: "models/gemini-3.1-flash-image", displayName: "Nano Banana 2", inputTokenLimit: 65_536, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent", "countTokens", "batchGenerateContent"], thinking: true },
    { name: "models/gemini-3.5-transcribe", displayName: "Gemini 3.5 Transcribe", inputTokenLimit: 98_304, outputTokenLimit: 32_768, supportedGenerationMethods: ["generateContent", "countTokens"] },
    { name: "models/gemini-2.5-computer-use-preview-10-2025", displayName: "Gemini 2.5 Computer Use Preview 10-2025", inputTokenLimit: 131_072, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent", "countTokens"], thinking: true },
    { name: "models/gemini-3.8-live", displayName: "Gemini 3.8 Live", inputTokenLimit: 131_072, outputTokenLimit: 65_536, supportedGenerationMethods: ["bidiGenerateContent"] },
    { name: "models/gemini-embedding-2", displayName: "Gemini Embedding 2", inputTokenLimit: 8_192, outputTokenLimit: 1, supportedGenerationMethods: ["embedContent", "countTokens"] },
  ],
};

afterEach(() => {
  clearPublishedModelCatalogs();
});

function listFetch() {
  return vi.fn<typeof fetch>().mockImplementation(async () => Response.json(LIVE_LIST));
}

async function discover(fetchImpl = listFetch()) {
  const resolver = new ModelMetadataResolver({ fetchImpl, env: { GEMINI_API_KEY: "gemini-fixture-key" } });
  return { resolver, fetchImpl, models: await resolver.discoverGeminiModels({}) };
}

describe("Gemini live model list", () => {
  test("keeps only chat models the bundled registry does not know", () => {
    const rows = parseGeminiLiveModels(LIVE_LIST);
    expect(rows?.map((row) => row.model)).toEqual(["gemini-3.1-flash-lite-preview", FUTURE]);
    expect(rows?.find((row) => row.model === FUTURE)).toEqual({
      model: FUTURE,
      displayName: "Gemini 4 Futura Preview",
      inputTokenLimit: 2_097_152,
      outputTokenLimit: 32_768,
      thinking: true,
    });
    expect(parseGeminiLiveModels({ data: [] })).toBeUndefined();
    expect(parseGeminiLiveModels({ models: [] })).toEqual([]);
  });

  test.each([
    ["gemini-4-futura-preview", true],
    ["gemini-3.9-flash", true],
    ["gemma-5-12b-it", true],
    ["gemini-3.8-flash-tts", false],
    ["gemini-3.1-flash-image", false],
    ["gemini-3.8-live", false],
    ["gemini-embedding-2", false],
    ["gemini-flsh", false],
    ["xyz", false],
  ] as const)("recognizes the shape of a chat model id: %s", (model, expected) => {
    expect(looksLikeGeminiChatModelId(model)).toBe(expected);
  });

  test("builds a catalog row with the listed limits, the thinking flag, and no levels", () => {
    const row = parseGeminiLiveModels(LIVE_LIST)!.find((entry) => entry.model === FUTURE)!;
    expect(geminiLiveCatalogEntry(row, 0)).toMatchObject({
      provider: "gemini",
      model: FUTURE,
      contextWindow: 2_097_152,
      maxOutputTokens: 32_768,
      maxOutputTokensUpperLimit: 32_768,
      supportsToolUse: true,
      supportsThinking: true,
      supportedReasoningLevels: [],
      visibility: "list",
    });
  });

  test("reads the list with the Gemini key header and publishes the new rows", async () => {
    const { fetchImpl, models } = await discover();
    expect(models?.map((row) => row.model)).toEqual(["gemini-3.1-flash-lite-preview", FUTURE]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    );
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-goog-api-key")).toBe("gemini-fixture-key");
    expect(headers.get("authorization")).toBeNull();
    expect(resolveRegisteredModelCatalogEntry({ provider: "gemini", model: FUTURE })).toMatchObject({
      contextWindow: 2_097_152,
      maxOutputTokens: 32_768,
      supportedReasoningLevels: [],
    });
    expect(resolveProviderModelCapabilities({ provider: "gemini", model: FUTURE }).acceptsReasoningEffort).toBe(false);
    // Registered models keep their reviewed rows, including Argon's 65,536
    // streaming output, not the list's 32,768 non-streaming cap.
    expect(resolveRegisteredModelCatalogEntry({ provider: "gemini", model: "gemini-4-argon" })).toMatchObject({
      maxOutputTokens: 65_536,
      supportedReasoningLevels: ["low", "medium", "high"],
    });
  });

  test("does not read the list without an API key", async () => {
    const fetchImpl = listFetch();
    const resolver = new ModelMetadataResolver({ fetchImpl, env: {} });
    expect(await resolver.discoverGeminiModels({})).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("plans an unregistered model against the listed window when a session resolves it", async () => {
    const fetchImpl = listFetch();
    const resolver = new ModelMetadataResolver({ fetchImpl, env: { GEMINI_API_KEY: "gemini-fixture-key" } });
    const metadata = await resolver.resolve({ provider: "gemini", model: FUTURE, config: {} });
    expect(metadata).toMatchObject({ contextWindow: 2_097_152, maxOutputTokens: 32_768, usedFallbackModelMetadata: false });
    // A registered model resolves without reading the list.
    fetchImpl.mockClear();
    await resolver.resolve({ provider: "gemini", model: "gemini-3.8-flash", config: {} });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/models?pageSize"))).toBe(false);
  });

  test("runs a listed model at its default thinking instead of failing an effort", async () => {
    // Not listed yet: the effort still fails before transport, as before.
    expect(() => resolveGeminiReasoningEffort(FUTURE, "high")).toThrow(/reasoning effort/iu);
    await discover();
    expect(resolveGeminiReasoningEffort(FUTURE, "high")).toBeUndefined();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    }));
    const provider = new GeminiProvider({
      model: FUTURE,
      endpointPlan: createGeminiEndpointPlan(),
      credentialPlan: { kind: "api-key", credential: "fixture", source: "factory" },
      fetchImpl,
    });
    await provider.chat([{ role: "user", content: "hi" }], { reasoningEffort: "high" });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(`/models/${FUTURE}:generateContent`);
    expect(body.generationConfig).not.toHaveProperty("thinkingConfig");
  });

  test("selects a listed model and still catches a typo once the list is known", async () => {
    // Before this process has read the list, a Gemini-shaped id is accepted
    // and anything else still gets the suggestion.
    expect(() => assertModelCatalogSelection({}, "gemini", FUTURE, {})).not.toThrow();
    expect(() => assertModelCatalogSelection({}, "gemini", "xyz", {})).toThrow(/unknown model 'xyz'.*did you mean/u);
    await discover();
    expect(() => assertModelCatalogSelection({}, "gemini", FUTURE, {})).not.toThrow();
    expect(() => assertModelCatalogSelection({}, "gemini", "gemini-3.1-flash-lite-preview", {})).not.toThrow();
    expect(() => assertModelCatalogSelection({}, "gemini", "gemini-4-futura", {}))
      .toThrow(/unknown model 'gemini-4-futura'.*did you mean/u);
    expect(() => assertModelCatalogSelection({}, "gemini", "gemini-3.8-flash", {})).not.toThrow();
  });

  test("shows a listed model's cost as unknown instead of borrowing a price", async () => {
    await discover();
    expect(resolveModelCostEntry({ provider: "gemini", model: FUTURE }, DEFAULT_MODEL_COSTS)).toBeNull();
    const cost = computeUsdCostWithResolution({
      model: FUTURE, provider: "gemini", inputTokens: 1_000, outputTokens: 100,
      cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
      webSearchRequests: 0, totalTokens: 1_100, turns: 1, singleCall: true,
    }, DEFAULT_MODEL_COSTS);
    expect(cost).toMatchObject({ known: false, costEstimated: true });
    expect(cost).not.toHaveProperty("matchedKey");
  });
});
