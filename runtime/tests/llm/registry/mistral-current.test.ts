import { describe, expect, it, vi } from "vitest";
import { createProvider } from "../../../src/llm/provider.js";
import { resolveProviderModelInput } from "../../../src/config/provider-model-authority.js";
import { BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../../src/llm/registry/provider-info.js";
import { resolveModelCatalogMetadata, resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { DEFAULT_MODEL_COSTS } from "../../../src/session/cost.js";
import { ModelMetadataResolver } from "../../../src/llm/model-metadata.js";
import { getOpenAICompatibleContextWindow, getOpenAICompatibleMaxOutputTokens } from "../../../src/llm/openai-compatible-token-limits.js";
import type { LLMTool } from "../../../src/llm/types.js";

const models = ["mistral-large-latest", "zai-glm-5-3", "zai-glm-5-2"] as const;
const tool: LLMTool = { type: "function", function: {
  name: "echo", description: "Echo the value", parameters: {
    type: "object", properties: { value: { type: "string" } }, required: ["value"],
  },
} };

describe("current documented Mistral routes outside an account inventory", () => {
  it.each(models)("admits %s with hosted capabilities and no invented exact limits", model => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.mistral).toContain(model);
    expect(resolveProviderModelInput({}, "mistral", model)).toEqual({ provider: "mistral", model });
    expect(resolveRegisteredModelCatalogEntry({ provider: "mistral", model })).toMatchObject({
      supportsToolUse: true, supportsParallelToolCalls: true, supportsStructuredOutput: true,
      inputModalities: model === "mistral-large-latest" ? ["text", "image"] : ["text"],
      supportedReasoningLevels: [],
    });
    expect(resolveModelCatalogMetadata({ provider: "mistral", model })).toEqual({});
    expect(new ModelMetadataResolver({ env: {} }).resolveSync({ provider: "mistral", model, config: {} }))
      .toMatchObject({ source: "conservative_fallback", usedFallbackModelMetadata: true });
  });

  it("resolves only documented aliases and prices Mistral hosting independently", () => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "mistral", model: "mistral-large-2512" })?.model).toBe("mistral-large-latest");
    expect(resolveRegisteredModelCatalogEntry({ provider: "mistral", model: "zai-glm-latest" })?.model).toBe("zai-glm-5-3");
    expect(resolveRegisteredModelCatalogEntry({ provider: "mistral", model: "zai-glm-5" })?.model).toBe("zai-glm-5-3");
    expect(resolveRegisteredModelCatalogEntry({ provider: "mistral", model: "zai-glm-5-4" })).toBeUndefined();
    for (const model of ["mistral-large-latest", "mistral-large-2512"]) {
      expect(getOpenAICompatibleContextWindow(model, { provider: "mistral" })).toBeUndefined();
      expect(getOpenAICompatibleMaxOutputTokens(model, { provider: "mistral" })).toBeUndefined();
    }
    expect(DEFAULT_MODEL_COSTS["mistral:mistral-large-latest"]).toMatchObject({ inputUsdPer1K: .0005, outputUsdPer1K: .0015 });
    expect(DEFAULT_MODEL_COSTS["mistral:mistral-large-latest"]?.cachedInputUsdPer1K).toBeCloseTo(.00005);
    expect(DEFAULT_MODEL_COSTS["mistral:zai-glm-5-3"]).toMatchObject({ inputUsdPer1K: .0014, outputUsdPer1K: .0044 });
    expect(DEFAULT_MODEL_COSTS["mistral:zai-glm-5-2"]?.cachedInputUsdPer1K).toBeCloseTo(.00014);
    expect(DEFAULT_MODEL_COSTS["mistral:zai-glm-5-3"]).toEqual(DEFAULT_MODEL_COSTS["mistral:zai-glm-latest"]);
  });

  it.each(models)("uses the ordinary Mistral chat/tool wire for %s", async model => {
    const requests: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)); requests.push(request);
      const useTool = Array.isArray(request.tools);
      return new Response(JSON.stringify({ model, choices: [{ message: {
        role: "assistant", content: useTool ? "" : "OK",
        ...(useTool ? { tool_calls: [{ id: "audit_call", type: "function", function: { name: "echo", arguments: '{"value":"ok"}' } }] } : {}),
      }, finish_reason: useTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }), { headers: { "content-type": "application/json" } });
    });
    const provider = createProvider("mistral", { model, apiKey: "test-only", extra: { fetchImpl, maxRetries: 0 } });
    try {
      const messages = [{ role: "user" as const, content: "Reply OK." }];
      expect((await provider.chat(messages, { maxOutputTokens: 128, reasoningEffort: "high" })).content).toBe("OK");
      const response = await provider.chat(messages, { tools: [tool], toolChoice: "auto", maxOutputTokens: 128 });
      expect(response.toolCalls).toMatchObject([{ name: "echo", arguments: '{"value":"ok"}' }]);
      expect(response.usage).toMatchObject({ promptTokens: 8, completionTokens: 4 });
      for (const request of requests) {
        expect(request).toMatchObject({ model, max_tokens: 128 });
        expect(request.reasoning_effort).toBeUndefined();
        expect(request.thinking).toBeUndefined();
        expect(request.tool_stream).toBeUndefined();
      }
    } finally { await provider.dispose?.(); }
  });
});
