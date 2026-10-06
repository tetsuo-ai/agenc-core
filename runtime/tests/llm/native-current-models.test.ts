import { describe, expect, test, vi } from "vitest";
import { OPENAI_CURRENT_MODEL_CATALOG } from "../../src/llm/registry/openai-current-models.js";
import { NVIDIA_CURRENT_MODEL_CATALOG } from "../../src/llm/registry/nvidia-current-models.js";
import { resolveRegisteredModelCatalogEntry } from "../../src/llm/registry/model-catalog.js";
import { BUILT_IN_PROVIDER_MODEL_CATALOG, BUILT_IN_PROVIDER_DEFAULT_MODELS } from "../../src/llm/registry/provider-info.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { GeminiProvider } from "../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../src/llm/providers/gemini/endpoint-plan.js";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { buildOpenAIResponsesRequest } from "../../src/llm/wire/responses-openai.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import { resolveReasoningEffort } from "../../src/llm/reasoning-effort.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS } from "../../src/session/cost.js";
import type { LLMTool } from "../../src/llm/types.js";

const TOOL: LLMTool = { type: "function", function: { name: "echo", description: "Echo a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } };
const messages = [{ role: "user" as const, content: "Call echo with ok" }];

describe("current native provider catalog", () => {
  test.each([...OPENAI_CURRENT_MODEL_CATALOG, ...NVIDIA_CURRENT_MODEL_CATALOG])("registers $provider/$model with an explicit output ceiling", entry => {
    expect(resolveRegisteredModelCatalogEntry(entry)).toEqual(entry);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG[entry.provider]).toContain(entry.model);
    expect(entry.maxOutputTokensUpperLimit).toBeGreaterThan(0);
  });
  test("preserves provider defaults and excludes retired picker aliases", () => {
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.openai).toBe("gpt-5");
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.gemini).toBe("gemini-3.8-flash");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG["nvidia-nim"]?.[0]).toBe("openai/gpt-oss-120b");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openai).not.toContain("gpt-5.1-codex");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.gemini).not.toContain("gemini-3-pro-preview");
  });
  test.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-nano"])("carries documented none reasoning for %s", model => {
    expect(resolveReasoningEffort({ provider: "openai", model }).levels).toContain("none");
    expect(buildOpenAIResponsesRequest({ model, messages, tools: [TOOL], options: { reasoningEffort: "none" } }).reasoning?.effort).toBe("none");
  });
});

describe("Responses-only and non-streaming OpenAI variants", () => {
  const payload = { status: "completed", output: [{ type: "function_call", call_id: "call_1", name: "echo", arguments: '{"value":"ok"}' }], usage: { input_tokens: 8, output_tokens: 6 } };
  test.each(["gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro", "o1-pro", "o3-pro"])("routes %s to Responses despite a Chat Completions preference", async model => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    const provider = new OpenAIProvider({ model, apiKey: "fixture", fetchImpl, useResponsesApi: false });
    const response = await provider.chat(messages, { tools: [TOOL], maxOutputTokens: 128 });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.openai.com/v1/responses");
    expect(response.toolCalls[0]?.name).toBe("echo");
  });
  test.each(["o1-pro", "o3-pro-2025-06-10"])("buffers %s without an SSE request", async model => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    const provider = new OpenAIProvider({ model: "gpt-5", apiKey: "fixture", fetchImpl, useResponsesApi: false });
    const onChunk = vi.fn();
    const response = await provider.chatStream(messages, onChunk, { model, tools: [TOOL], maxOutputTokens: 128 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ model, stream: false, max_output_tokens: 128 });
    expect(response.toolCalls[0]?.name).toBe("echo");
    expect(onChunk).toHaveBeenCalledWith(expect.objectContaining({ done: true, toolCalls: response.toolCalls }));
  });
});

describe("NIM hosted wire limits", () => {
  test.each(NVIDIA_CURRENT_MODEL_CATALOG)("honors hosted output and effort limits for $model", entry => {
    const hints = chatCompletionsCapabilityHintsForProvider("nvidia-nim", entry.model);
    const effort = entry.supportedReasoningLevels[0];
    const request = buildChatCompletionsRequest({ model: entry.model, messages, tools: [TOOL], maxTokens: 2_000_000, options: { toolChoice: "required", reasoningEffort: effort }, providerCapabilityHints: hints });
    expect(request.max_tokens).toBe(entry.maxOutputTokensUpperLimit);
    expect(request).not.toHaveProperty("parallel_tool_calls");
    if (effort) expect(request.reasoning_effort).toBe(effort);
    else expect(request).not.toHaveProperty("reasoning_effort");
    if (entry.model === "moonshotai/kimi-k3") expect(request).not.toHaveProperty("tool_choice");
    if (entry.model === "meta/muse-glimmer-30b") expect(request.tool_choice).toBe("auto");
  });
  test("keeps NIM Kimi replay provider scoped with the hosted output ceiling", () => {
    const hints = chatCompletionsCapabilityHintsForProvider("nvidia-nim", "moonshotai/kimi-k3");
    expect(hints).toMatchObject({ replaysReasoningContent: true, replaysReasoningContentOnlyForIntactHistory: true, outputTokensCeiling: 65_536, reasoningContentProvenance: { provider: "nvidia-nim", model: "moonshotai/kimi-k3" } });
    expect(hints).not.toHaveProperty("thinkingConfig");
    expect(hints).not.toHaveProperty("imageInputContract");
  });
});

const GEMINI = [
  ["gemini-2.5-pro", 1_048_576, 65_536, undefined],
  ["gemini-2.5-flash-lite", 1_048_576, 65_536, undefined],
  ["gemini-3-flash-preview", 1_048_576, 65_536, "minimal"],
  ["gemini-3.1-pro-preview-customtools", 1_048_576, 65_536, "low"],
  ["gemma-4-31b-it", 262_144, 32_768, "minimal"],
  ["gemma-4-26b-a4b-it", 262_144, 32_768, "high"],
  ["gemini-robotics-er-2-preview", 131_072, 65_536, "low"],
] as const;

describe("Gemini current models", () => {
  test.each(GEMINI)("uses live limits and correct thinking control for %s", async (model, context, output, effort) => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.gemini).toContain(model);
    expect(resolveRegisteredModelCatalogEntry({ provider: "gemini", model })).toMatchObject({ contextWindow: context, maxOutputTokensUpperLimit: output, supportsToolUse: true });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ functionCall: { name: "echo", args: { value: "ok" } } }] }, finishReason: "STOP" }] }));
    const provider = new GeminiProvider({ model, endpointPlan: createGeminiEndpointPlan(), credentialPlan: { kind: "api-key", credential: "fixture", source: "factory" }, fetchImpl });
    const response = await provider.chat(messages, { tools: [TOOL], reasoningEffort: effort, maxOutputTokens: 128 });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.tools[0].functionDeclarations[0].name).toBe("echo");
    if (effort) expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: effort });
    else expect(body.generationConfig).not.toHaveProperty("thinkingConfig");
    expect(response.toolCalls[0]?.name).toBe("echo");
  });
});

describe("provider-specific price resolution", () => {
  const usage = (provider: string, model: string) => ({ provider, model, inputTokens: 1000, outputTokens: 1000, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: 2000, turns: 1 });
  test.each([["openai", "gpt-4-turbo", 0.04], ["openai", "chat-latest", 0.035], ["gemini", "gemini-3.1-pro-preview-customtools", 0.014], ["gemini", "gemma-4-31b-it", 0], ["gemini", "gemini-robotics-er-2-preview", 0.006]] as const)("prices %s/%s independently", (provider, model, expected) => {
    expect(computeUsdCostWithResolution(usage(provider, model), DEFAULT_MODEL_COSTS).costUsd).toBeCloseTo(expected, 7);
  });
  test.each(NVIDIA_CURRENT_MODEL_CATALOG)("keeps unpublished NIM price unknown for $model", entry => {
    expect(computeUsdCostWithResolution(usage(entry.provider, entry.model), DEFAULT_MODEL_COSTS)).toMatchObject({ known: false, costEstimated: true });
  });
});
