import { describe, expect, it, vi } from "vitest";
import { createProvider } from "../../../src/llm/provider.js";
import type { LLMTool } from "../../../src/llm/types.js";
import { resolveProviderRuntimeRequest } from "../../../src/llm/provider-request.js";
import { buildProviderModelCatalog, resolveProviderModelInput } from "../../../src/config/provider-model-authority.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { QWEN_CURRENT_MODELS } from "../../../src/llm/registry/qwen-current-models.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import { buildChatCompletionsRequest } from "../../../src/llm/wire/chat-completions.js";
import { DEFAULT_MODEL_COSTS, resolveModelCostEntry, selectCallRates } from "../../../src/session/cost.js";

const tool: LLMTool = { type: "function", function: {
  name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
}};
const entry = (model: string, provider = "qwen") => resolveRegisteredModelCatalogEntry({ provider, model });
const messages = [{ role: "user" as const, content: "Call echo." }];

describe("Qwen current native and hosted chat models", () => {
  it("keeps reviewed PAYG routes on the selected provider through catalog and runtime resolution", () => {
    const catalog = buildProviderModelCatalog({});
    for (const { model } of QWEN_CURRENT_MODELS) {
      expect(catalog.qwen).toContain(model);
      expect(catalog["qwen-token-plan"]).not.toContain(model);
      expect(resolveProviderModelInput({}, "qwen", model)).toEqual({ provider: "qwen", model });
      expect(resolveProviderRuntimeRequest({ provider: "qwen", model, config: {}, environment: {} }).requested)
        .toMatchObject({ model });
    }
    expect(entry("glm-5.3-future")).toBeUndefined();
    expect(entry("kimi/kimi-k3")?.model).toBe("kimi/kimi-k3");
    expect(entry("kimi-k3")?.model).toBe("kimi-k3");
  });

  it("uses exact regional limits and preserves unpublished limits", () => {
    expect(entry("glm-5.1")).toMatchObject({ contextWindow: 202_745, maxOutputTokens: 131_072 });
    expect(entry("kimi-k2.7-code")).toMatchObject({ contextWindow: 262_144, maxOutputTokens: 16_384, inputModalities: ["text", "image"] });
    expect(entry("kimi-k3")).toMatchObject({ contextWindow: 1_048_576, maxOutputTokens: 1_048_576 });
    expect(entry("deepseek-v4.1-flash")).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 393_216, inputModalities: ["text", "image"] });
    expect(entry("qwen3.6-27b")?.inputModalities).toEqual(["text", "image"]);
    expect(entry("glm-5.3-prime")?.contextWindow).toBeUndefined();
    expect(entry("ZHIPU/GLM-5.3")?.maxOutputTokens).toBeUndefined();
    expect(entry("qwen3.7-plus")?.maxOutputTokens).toBe(131_072);
    expect(entry("qwen3.7-flash")?.maxOutputTokens).toBe(131_072);
  });

  it("uses route-specific reasoning enums and never disables thinking-only models", () => {
    const wire = (model: string, effort: "none" | "low" | "max") => buildChatCompletionsRequest({
      model, messages, tools: [tool], options: { reasoningEffort: effort, toolChoice: "auto" },
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("qwen", model),
    });
    expect(wire("qwen3.8-27b", "low").reasoning_effort).toBe("low");
    expect(wire("qwen3.8-2.4t-a95b", "none").enable_thinking).toBeUndefined();
    expect(wire("glm-5.3", "low")).toMatchObject({ reasoning_effort: "low", tool_stream: true, tool_choice: "auto" });
    expect(wire("glm-5.3", "none").enable_thinking).toBeUndefined();
    expect(wire("glm-5.2", "none").reasoning_effort).toBe("none");
    expect(wire("glm-5.1", "max").reasoning_effort).toBeUndefined();
    expect(wire("kimi/kimi-k3", "low").reasoning_effort).toBeUndefined();
    expect(wire("kimi/kimi-k3", "max").reasoning_effort).toBe("max");
    expect(wire("qwen3-next-80b-a3b-thinking", "low").enable_thinking).toBeUndefined();
  });

  it.each(["qwen3-next-80b-a3b-thinking", "qwen3.5-omni-plus"])("buffers mandatory SSE through chat for %s", async (model) => {
    let request: Record<string, unknown> = {};
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      request = JSON.parse(String(init?.body));
      const frames = [
        { model, choices: [{ index: 0, delta: { reasoning_content: "Use echo." } }] },
        { model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "audit_call", type: "function", function: { name: "echo", arguments: '{"value":' } }] } }] },
        { model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] }, finish_reason: "tool_calls" }] },
        { model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 3 } } },
      ];
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const provider = createProvider("qwen", { model: "qwen3.8-max", apiKey: "test-only", extra: { fetchImpl, maxRetries: 0 } });
    try {
      const response = await provider.chat(messages, { model, tools: [tool], toolChoice: "required", maxOutputTokens: 128, singleWireAttempt: true });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(request).toMatchObject({ model, stream: true, max_tokens: 128, stream_options: { include_usage: true } });
      expect(request.max_completion_tokens).toBeUndefined();
      if (model.includes("thinking")) expect(request.thinking_budget).toBe(128);
      expect(response.toolCalls).toMatchObject([{ name: "echo", arguments: '{"value":"ok"}' }]);
      expect(response.usage).toMatchObject({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
      expect(response.providerReasoningContent).toBe("Use echo.");
      expect(response.providerReasoningProvenance).toEqual({ provider: "qwen", model });
    } finally { await provider.dispose?.(); }
  });

  it("prices four Singapore Coder tiers at decimal boundaries and keeps provider-scoped rates", () => {
    const rates = DEFAULT_MODEL_COSTS["qwen:qwen3-coder-plus"]!;
    for (const [tokens, input, output] of [[32_000, .001, .005], [32_001, .0018, .009], [128_001, .003, .015], [256_001, .006, .06]]) {
      expect(selectCallRates(rates, { singleCallInputTokens: tokens }).rates).toMatchObject({ inputUsdPer1K: input, outputUsdPer1K: output });
    }
    expect(DEFAULT_MODEL_COSTS["qwen:glm-5.3"]?.cachedInputUsdPer1K).toBeCloseTo(.00028);
    expect(DEFAULT_MODEL_COSTS["zai:glm-5.3"]?.cachedInputUsdPer1K).toBeCloseTo(.00026);
    expect(resolveModelCostEntry({ provider: "qwen-token-plan", model: "glm-5.3" }, DEFAULT_MODEL_COSTS)).toBeNull();
    for (const model of ["deepseek-v4.1-flash", "qwen3-8b", "qwen3-omni-flash", "ZHIPU/GLM-5.3", "kimi/kimi-k3"]) {
      expect(resolveModelCostEntry({ provider: "qwen", model }, DEFAULT_MODEL_COSTS)).toBeNull();
    }
  });
});
