import { describe, expect, it, vi } from "vitest";

import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../../src/llm/registry/provider-info.js";
import { resolveMistralChatModel } from "../../../src/llm/registry/mistral-models.js";
import { createProvider } from "../../../src/llm/provider.js";
import type { LLMReasoningEffort, LLMTool } from "../../../src/llm/types.js";
import { buildChatCompletionsRequest, parseChatCompletionsResponse } from "../../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import { DEFAULT_MODEL_COSTS } from "../../../src/session/cost.js";

const tool: LLMTool = {
  type: "function",
  function: { name: "echo", description: "Echo", parameters: { type: "object", properties: {} } },
};

function wire(provider: string, model: string, reasoningEffort: LLMReasoningEffort) {
  return buildChatCompletionsRequest({
    model, messages: [{ role: "user", content: "Call echo." }], tools: [tool],
    options: { reasoningEffort, toolChoice: "required", maxOutputTokens: 128 },
    providerCapabilityHints: chatCompletionsCapabilityHintsForProvider(provider, model),
  });
}

const entry = (provider: string, model: string) => resolveRegisteredModelCatalogEntry({ provider, model });

describe("September 2026 native provider catalog refresh", () => {
  it("resolves Mistral live aliases without duplicating picker rows or inferring future releases", () => {
    expect(entry("mistral", "magistral-small-latest")?.model).toBe("mistral-small-latest");
    expect(entry("mistral", "mistral-medium-3-5")?.supportedReasoningLevels).toEqual(["none", "high"]);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.mistral).toContain("codestral-latest");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.mistral).not.toContain("mistral-code-latest");
    expect(entry("mistral", "codestral-2508")?.contextWindow).toBe(256_000);
    expect(entry("mistral", "ministral-3b-2512")?.contextWindow).toBe(131_072);
    expect(entry("mistral", "mistral-small-future")).toBeUndefined();
    expect(wire("mistral", "mistral-small-latest", "high").reasoning_effort).toBe("high");
    expect(wire("mistral", "codestral-latest", "high").reasoning_effort).toBeUndefined();
  });

  it.each([false, true])("preserves Mistral thinking chunks through chat, stream=%s, and same-route tool replay", async (stream) => {
    const model = "mistral-small-latest";
    const content = [
      { type: "thinking", thinking: [{ type: "text", text: "Check the tool." }] },
      { type: "text", text: "Ready." },
    ];
    const toolCalls = [{ id: "audit_call", type: "function", function: { name: "echo", arguments: "{}" } }];
    const response = { model, choices: [{ message: { role: "assistant", content, tool_calls: toolCalls }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (!stream) return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
      const frames = [
        { model, choices: [{ index: 0, delta: { content: [content[0]] } }] },
        { model, choices: [{ index: 0, delta: { content: [content[1]], tool_calls: toolCalls.map((call) => ({ ...call, index: 0 })) }, finish_reason: "tool_calls" }], usage: response.usage },
      ];
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const provider = createProvider("mistral", { model, apiKey: "test-only", extra: { fetchImpl } });
    try {
      const messages = [{ role: "user" as const, content: "Call echo." }];
      const result = stream
        ? await provider.chatStream!(messages, () => {}, { tools: [tool], reasoningEffort: "high" })
        : await provider.chat(messages, { tools: [tool], reasoningEffort: "high" });
      expect(result.content).toBe("Ready.");
      expect(result.providerReasoningContent).toBe("Check the tool.");
      expect(result.toolCalls).toHaveLength(1);
      const request = buildChatCompletionsRequest({ model, tools: [tool], messages: [
        ...messages,
        { role: "assistant", content: result.content, toolCalls: result.toolCalls,
          providerReasoningContent: result.providerReasoningContent, providerReasoningProvenance: result.providerReasoningProvenance },
        { role: "tool", toolCallId: result.toolCalls[0]!.id, content: "ok" },
      ], providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("mistral", model) });
      const assistant = (request.messages as Array<Record<string, unknown>>).find((message) => message.role === "assistant");
      expect(assistant?.content).toEqual(content);
      expect(assistant?.reasoning_content).toBeUndefined();
      // A foreign response cannot introduce hidden replay state on Mistral.
      const foreign = parseChatCompletionsResponse(model, response, { model, messages, tools: [tool], providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("openai", model) });
      expect(foreign.providerReasoningContent).toBeUndefined();
    } finally { await provider.dispose?.(); }
  });

  it("keeps unpublished Mistral output limits absent and prices exact alias groups", () => {
    expect(entry("mistral", "codestral-latest")?.maxOutputTokens).toBeUndefined();
    expect(entry("mistral", "labs-leanstral-1-5-1")?.maxOutputTokens).toBeUndefined();
    expect(DEFAULT_MODEL_COSTS["mistral:codestral-2508"]).toMatchObject({
      inputUsdPer1K: 0.0003, outputUsdPer1K: 0.0009,
    });
    expect(DEFAULT_MODEL_COSTS["mistral:codestral-2508"]?.cachedInputUsdPer1K).toBeCloseTo(0.00003, 12);
    expect(DEFAULT_MODEL_COSTS["mistral:magistral-small-latest"]).toEqual(DEFAULT_MODEL_COSTS["mistral:mistral-small-latest"]);
    expect(resolveMistralChatModel("labs-leanstral-1-5")?.free).toBe(true);
  });

  it("admits Z.AI FlashX only on PAYG and preserves the thinking-only wire contract", () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.zai).toContain("glm-5.3-flashx");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG["zai-coding-plan"]).not.toContain("glm-5.3-flashx");
    expect(entry("zai-coding-plan", "glm-5.3-flashx")).toBeUndefined();
    expect(entry("zai", "glm-5.3-flashx")).toMatchObject({
      contextWindow: 1_000_000, maxOutputTokens: 131_072, inputModalities: ["text", "image"],
      supportedReasoningLevels: ["low", "high", "max"],
    });
    const request = wire("zai", "glm-5.3-flashx", "max");
    expect(request.reasoning_effort).toBe("max");
    expect(request.thinking).toEqual({ type: "enabled", clear_thinking: true });
    expect(request.tool_choice).toBe("auto");
    expect(() => createProvider("zai-coding-plan", { model: "glm-5.3-flashx", apiKey: "test-only" })).toThrow(/allowlist/);
    expect(DEFAULT_MODEL_COSTS["zai:glm-5.3-flashx"]).toMatchObject({
      inputUsdPer1K: 0.00037, outputUsdPer1K: 0.00125, cachedInputUsdPer1K: 0.000075,
    });
  });

  it("keeps new Qwen models on PAYG and never disables the thinking-only 2.4T model", () => {
    for (const model of ["qwen3.8-27b", "qwen3.8-2.4t-a95b", "qwen3.8-omni-flash"]) {
      expect(BUILT_IN_PROVIDER_MODEL_CATALOG.qwen).toContain(model);
      expect(BUILT_IN_PROVIDER_MODEL_CATALOG["qwen-token-plan"]).not.toContain(model);
      expect(entry("qwen", model)).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 131_072 });
    }
    const request = wire("qwen", "qwen3.8-2.4t-a95b", "high");
    expect(request.tool_choice).toBe("auto");
    expect(request.enable_thinking).toBeUndefined();
    expect(request.reasoning_effort).toBeUndefined();
    expect(wire("qwen", "qwen3.8-omni-flash", "none").reasoning_effort).toBe("none");
    expect(entry("qwen", "qwen3.8-2.4t-a95b")?.inputModalities).toEqual(["text"]);
    expect(entry("qwen", "qwen3.8-27b")?.inputModalities).toEqual(["text", "image"]);
    expect(DEFAULT_MODEL_COSTS["qwen:qwen3.8-omni-flash"]).toMatchObject({
      inputUsdPer1K: 0.00015, outputUsdPer1K: 0.00047, cachedInputUsdPer1K: 0.000016,
    });
  });
});
