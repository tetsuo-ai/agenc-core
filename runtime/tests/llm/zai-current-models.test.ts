import { describe, expect, test, vi } from "vitest";
import { resolveRegisteredModelCatalogEntry } from "../../src/llm/registry/model-catalog.js";
import { BUILT_IN_PROVIDER_MODEL_CATALOG, BUILT_IN_PROVIDER_DEFAULT_MODELS } from "../../src/llm/registry/provider-info.js";
import { resolveProviderCapabilityEntry } from "../../src/llm/capabilities.js";
import { resolveReasoningEffort } from "../../src/llm/reasoning-effort.js";
import { ZaiProvider } from "../../src/llm/providers/zai/index.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../../src/session/cost.js";
import type { LLMMessage, LLMTool } from "../../src/llm/types.js";

const MODELS = [
  ["glm-5.2", 1_000_000, 131_072, 1.4, 4.4, .26],
  ["glm-5.1", 200_000, 131_072, 1.4, 4.4, .26],
  ["glm-5-turbo", 200_000, 131_072, undefined, undefined, undefined],
  ["glm-5", 200_000, 131_072, 1, 3.2, .2],
  ["glm-4.7", 200_000, 131_072, .6, 2.2, .11],
  ["glm-4.6", 200_000, 131_072, .6, 2.2, .11],
  ["glm-4.5", 128_000, 96_000, .6, 2.2, .11],
  ["glm-4.5-air", 128_000, 96_000, .2, 1.1, .03],
] as const;
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const TOOL: LLMTool = { type: "function", function: { name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { type: "string" } } } } };

describe("current ZAI PAYG generations", () => {
  test.each(MODELS)("registers %s with its own limits and native capability contract", (model, contextWindow, maxOutputTokens) => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.zai).toContain(model);
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.zai).toBe("glm-5.3");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG["zai-coding-plan"]).not.toContain(model);
    expect(resolveRegisteredModelCatalogEntry({ provider: "zai-coding-plan", model })).toBeUndefined();
    expect(resolveRegisteredModelCatalogEntry({ provider: "zai", model })).toMatchObject({ contextWindow, maxContextWindow: contextWindow, maxOutputTokens, inputModalities: ["text"], supportedReasoningLevels: model === "glm-5.2" ? EFFORTS : [] });
    expect(resolveProviderCapabilityEntry({ provider: "zai", model })).toMatchObject({ supportsToolUse: true, supportsImageInput: false, supportsExtendedThinking: true, acceptsThinkingHistory: true, acceptsReasoningEffort: model === "glm-5.2" });
    expect(resolveReasoningEffort({ provider: "zai", model }).levels).toEqual(model === "glm-5.2" ? EFFORTS : []);
  });
  test.each(MODELS)("prices %s only on the native PAYG route", (model, _context, _output, input, output, cached) => {
    const resolved = resolveModelCostEntry({ provider: "zai", model }, DEFAULT_MODEL_COSTS);
    if (input === undefined) expect(resolved).toBeNull();
    else {
      expect(resolved?.entry.inputUsdPer1K).toBeCloseTo(input / 1000, 10);
      expect(resolved?.entry.outputUsdPer1K).toBeCloseTo(output! / 1000, 10);
      expect(resolved?.entry.cachedInputUsdPer1K).toBeCloseTo(cached! / 1000, 10);
      expect(resolved?.entry.cachedInputIncludedInInputTokens).toBe(true);
    }
    expect(resolveModelCostEntry({ provider: "nvidia-nim", model }, DEFAULT_MODEL_COSTS)).toBeNull();
  });
  test.each(MODELS)("sends %s through Core without borrowing unsupported effort", async (model) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "fixture", model, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: '{"value":"ok"}' } }] } }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }));
    const provider = new ZaiProvider({ model, apiKey: "fixture", fetchImpl });
    const result = await provider.chat([{ role: "user", content: "Call echo" }], { tools: [TOOL], toolChoice: "required", maxOutputTokens: 128, reasoningEffort: "none" });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({ model, max_tokens: 128, tool_choice: "auto", thinking: { type: "enabled", clear_thinking: true } });
    if (model === "glm-5.2") expect(request.reasoning_effort).toBe("none");
    else expect(request).not.toHaveProperty("reasoning_effort");
    expect(request).not.toHaveProperty("parallel_tool_calls");
    expect(result.toolCalls[0]?.name).toBe("echo");
  });
  test.each(EFFORTS)("forwards documented GLM-5.2 effort %s", effort => {
    const hints = chatCompletionsCapabilityHintsForProvider("zai", "glm-5.2");
    expect(buildChatCompletionsRequest({ model: "glm-5.2", messages: [{ role: "user", content: "Hi" }], tools: [], options: { reasoningEffort: effort }, providerCapabilityHints: hints }).reasoning_effort).toBe(effort);
  });
  test.each(MODELS)("preserves adjacent tool reasoning for %s with provider provenance", (model) => {
    const messages: LLMMessage[] = [{ role: "user", content: "Call echo" }, { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "echo", arguments: '{}' }], providerReasoningContent: "original thinking", providerReasoningProvenance: { provider: "zai", model } }, { role: "tool", content: "ok", toolCallId: "call_1", toolName: "echo" }];
    const hints = chatCompletionsCapabilityHintsForProvider("zai", model);
    const request = buildChatCompletionsRequest({ model, messages, tools: [TOOL], providerCapabilityHints: hints });
    expect(request.messages[1]).toMatchObject({ reasoning_content: "original thinking" });
    expect(request.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(hints.streamsToolCalls === true).toBe(!model.startsWith("glm-4.5"));
  });
});
