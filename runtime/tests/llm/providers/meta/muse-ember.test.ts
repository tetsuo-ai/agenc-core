import { describe, expect, test, vi } from "vitest";

import { childModelProfile } from "../../../../src/agents/provider-selector-profiles.js";
import { defaultConfig } from "../../../../src/config/schema.js";
import { resolveProviderCapabilityEntry } from "../../../../src/llm/capabilities.js";
import { StaticModelsManager } from "../../../../src/llm/models-manager.js";
import { getTokenizerConfig } from "../../../../src/llm/token-estimation.js";
import { createProvider } from "../../../../src/llm/provider.js";
import { resolveReasoningEffort } from "../../../../src/llm/reasoning-effort.js";
import { resolveModelCatalogMetadata, resolveRegisteredModelCatalogEntry } from "../../../../src/llm/registry/model-catalog.js";
import { isRegisteredMetaChatModel, metaModelUsesResponsesApi } from "../../../../src/llm/registry/meta-models.js";
import { BUILT_IN_PROVIDER_DEFAULT_MODELS, BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../../../src/llm/registry/provider-info.js";
import { resolveProviderStructuredOutputMode } from "../../../../src/llm/structured-output.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS, type ModelUsage } from "../../../../src/session/cost.js";
import type { LLMChatOptions } from "../../../../src/llm/types.js";

const MODEL = "muse-ember-1.0";
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function response(stream: boolean, content = "ok"): Response {
  return stream
    ? new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    })
    : new Response(JSON.stringify({
      model: MODEL, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } });
}

function usage(inputTokens: number, cachedInputTokens = 0): ModelUsage {
  return {
    provider: "meta", model: MODEL, inputTokens, cachedInputTokens,
    outputTokens: 10_000, cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
    webSearchRequests: 0, totalTokens: inputTokens + 10_000, turns: 1, singleCall: true,
  };
}

describe("Muse Ember", () => {
  test("registers only the standard Model API identity with the documented contract", () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.meta).toContain(MODEL);
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.meta).toBe("muse-wonder-1.0");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.meta[0]).toBe("muse-wonder-1.0");
    expect(resolveRegisteredModelCatalogEntry({ provider: "meta", model: MODEL })).toMatchObject({
      displayName: "Muse Ember", supportedReasoningLevels: LEVELS, defaultReasoningLevel: "max",
      inputModalities: ["text", "image"], supportsToolUse: true, supportsParallelToolCalls: true,
      supportsStructuredOutput: true, supportsReasoningSummaries: false, visibility: "list",
    });
    expect(resolveModelCatalogMetadata({ provider: "meta", model: MODEL })).toEqual({
      contextWindow: 1_048_576, maxContextWindow: 1_048_576,
      maxOutputTokens: 524_288, maxOutputTokensUpperLimit: 524_288,
    });
    for (const model of [MODEL, `meta/${MODEL}`, ` ${MODEL.toUpperCase()} `]) {
      expect(isRegisteredMetaChatModel(model)).toBe(true);
      expect(metaModelUsesResponsesApi(model)).toBe(false);
    }
    for (const model of ["muse-ember-1.0-contributor", "muse-ember-1.1", `${MODEL}/extra`]) {
      expect(isRegisteredMetaChatModel(model)).toBe(false);
      expect(BUILT_IN_PROVIDER_MODEL_CATALOG.meta).not.toContain(model);
    }
  });

  test("offers Ember in the model picker with its full output budget", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const manager = new StaticModelsManager({
      config: { ...defaultConfig(), model_provider: "meta", model: MODEL },
      fallbackProvider: "meta", metadata: { fetchImpl },
    });
    const contract = {
      slug: MODEL, contextWindow: 1_048_576, maxOutputTokens: 524_288,
      maxOutputTokensUpperLimit: 524_288, supportedReasoningLevels: LEVELS,
      defaultReasoningLevel: "max", usedFallbackModelMetadata: false,
    };
    expect(await manager.getModelInfo(MODEL)).toMatchObject(contract);
    expect((await manager.listModels()).find((model) => model.slug === MODEL)).toMatchObject(contract);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("grants the Spark capabilities and structured output on Chat Completions", () => {
    expect(resolveProviderCapabilityEntry({ provider: "meta", model: MODEL })).toMatchObject({
      supportsToolUse: true, supportsImageInput: true, supportsVisionInput: true,
      supportsStructuredOutput: true, supportsStructuredOutputWithTools: true,
      acceptsReasoningEffort: true, supportsProviderNativeWebSearch: false,
    });
    expect(resolveProviderStructuredOutputMode({ provider: "meta", model: MODEL, api: "chat_completions" }))
      .toBe("chat_response_format");
    expect(resolveProviderStructuredOutputMode({ provider: "meta", model: MODEL, api: "responses" }))
      .toBe("unsupported");
    expect(resolveReasoningEffort({ provider: "meta", model: MODEL })).toMatchObject({
      levels: LEVELS, defaultLevel: "max", chatLevels: new Set(LEVELS),
    });
  });

  test("uses Meta token estimation for the unqualified Ember model", () => {
    expect(getTokenizerConfig(MODEL).modelFamily).toBe("meta");
  });

  test("gives Ember a compact execution profile while keeping Spark and Wonder stronger", () => {
    const ember = childModelProfile("meta", MODEL);
    expect(ember).toBeDefined();
    expect(ember?.latencyMs).toBe(8_000);
    expect(ember?.quality.coding).toBeLessThan(childModelProfile("meta", "muse-spark-1.3")!.quality.coding);
    expect(ember?.quality.reasoning).toBeLessThan(childModelProfile("meta", "muse-wonder-1.0")!.quality.reasoning);
    expect(childModelProfile("meta", "muse-ember-1.0-contributor")).toBeUndefined();
  });

  test("sends image input and structured output with Meta tool controls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response(false, JSON.stringify({ answer: "ok" })));
    const provider = createProvider("meta", {
      apiKey: "meta-test", model: MODEL, extra: { fetchImpl },
      tools: [{ type: "function", function: {
        name: "read_file", description: "Read a file.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      } }],
    });
    await provider.chat([{ role: "user", content: [
      { type: "text", text: "Describe the image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
    ] }], {
      reasoningEffort: "max", toolChoice: "required", parallelToolCalls: true, stopSequences: ["END"],
      structuredOutput: { schema: { type: "json_schema", name: "answer", schema: {
        type: "object", properties: { answer: { type: "string" } }, required: ["answer"],
      } } },
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.reasoning_effort).toBe("max");
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "answer" } });
    expect(body.messages[0].content).toContainEqual({
      type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" },
    });
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.stop).toBeUndefined();
    await provider.chat([{ role: "user", content: "hello" }], { toolChoice: "none", reasoningEffort: "none" });
    const withoutTools = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(withoutTools.tools).toBeUndefined();
    expect(withoutTools.reasoning_effort).toBeUndefined();
  });

  test.each([false, true])("forwards all six efforts and strips none (stream=%s)", async (stream) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response(stream));
    const provider = createProvider("meta", { apiKey: "meta-test", model: MODEL, extra: { fetchImpl } });
    for (const reasoningEffort of [...LEVELS, "none", undefined] as const) {
      const options: LLMChatOptions = { reasoningEffort, maxOutputTokens: 524_288 };
      if (stream) await provider.chatStream([{ role: "user", content: "hello" }], () => {}, options);
      else await provider.chat([{ role: "user", content: "hello" }], options);
      const [url, init] = fetchImpl.mock.calls.at(-1)!;
      const body = JSON.parse(String(init?.body));
      expect(String(url)).toBe("https://api.meta.ai/v1/chat/completions");
      expect(body.reasoning_effort).toBe(reasoningEffort === "none" ? undefined : reasoningEffort);
      expect(body.max_completion_tokens).toBe(524_288);
      expect(body.max_tokens).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
    }
  });

  test.each([
    [100_000, 0, 0.015],
    [200_000, 0, 0.025],
    [200_001, 0, 0.0750003],
    [300_000, 0, 0.105],
    [200_000, 150_000, 0.0106],
    [200_001, 150_000, 0.0318003],
    [300_000, 300_000, 0.0186],
  ])("prices %i input including %i cached at $%s for the whole request", (input, cached, costUsd) => {
    expect(computeUsdCostWithResolution(usage(input, cached), DEFAULT_MODEL_COSTS)).toEqual({
      known: true, matchedKey: `meta:${MODEL}`, costUsd: expect.closeTo(costUsd, 9),
    });
  });

  test("adds search grounding and keeps accumulated input out of per-request tiers", () => {
    const call = { ...usage(300_000, 250_000), webSearchRequests: 2 };
    expect(computeUsdCostWithResolution(call, DEFAULT_MODEL_COSTS).costUsd).toBeCloseTo(0.038, 9);
    const { singleCall: _, ...accumulated } = call;
    expect(computeUsdCostWithResolution(accumulated, DEFAULT_MODEL_COSTS).costUsd).toBeCloseTo(0.016, 9);
  });
});
