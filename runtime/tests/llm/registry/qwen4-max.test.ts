import { afterEach, describe, expect, it, vi } from "vitest";
import { childModelProfile } from "../../../src/agents/provider-selector-profiles.js";
import { modelCapabilityTags } from "../../../src/commands/model-capability-tags.js";
import { buildProviderModelCatalog, resolveProviderModelInput } from "../../../src/config/provider-model-authority.js";
import { resolveProviderModelCapabilities } from "../../../src/llm/capabilities.js";
import { ModelMetadataResolver } from "../../../src/llm/model-metadata.js";
import { assertModelCatalogSelection } from "../../../src/llm/model-catalog-selection.js";
import { QwenProvider, QwenTokenPlanProvider } from "../../../src/llm/providers/qwen/index.js";
import { resolveReasoningEffort } from "../../../src/llm/reasoning-effort.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { BUILT_IN_PROVIDER_DEFAULT_MODELS } from "../../../src/llm/registry/provider-info.js";
import { resolveProviderStructuredOutputMode } from "../../../src/llm/structured-output.js";
import { roughTokenCountEstimationForProvider } from "../../../src/llm/token-estimation.js";
import type { LLMChatOptions, LLMMessage, LLMTool } from "../../../src/llm/types.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import { buildChatCompletionsRequest } from "../../../src/llm/wire/chat-completions.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../../../src/session/cost.js";
import { resolveSessionReasoningEffort } from "../../../src/session/session-reasoning-effort.js";

// Contract: docs/models/qwen4-max-2026-11.md (QwenCloud docs and live calls, 2026-11-16).
const model = "qwen4-max";
const providers = ["qwen", "qwen-token-plan"] as const;
type Provider = typeof providers[number];
const efforts = ["none", "low", "high", "xhigh"] as const;
const tool: LLMTool = { type: "function", function: {
  name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
} };

function fixture(provider: Provider, configured = model) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
    id: "chatcmpl-qwen4", model,
    choices: [{ message: { role: "assistant", content: "OK", reasoning_content: "Check the result." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 15 } },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const Provider = provider === "qwen" ? QwenProvider : QwenTokenPlanProvider;
  const instance = new Provider({
    apiKey: "fixture", model: configured, baseURL: "http://127.0.0.1:1/compatible-mode/v1", fetchImpl,
  });
  return { instance, fetchImpl, body: () => JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body)) };
}

describe("Qwen4 Max on Pay-As-You-Go and the Token Plan", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(providers)("registers the documented contract on %s", provider => {
    const entry = resolveRegisteredModelCatalogEntry({ provider, model });
    expect(entry).toMatchObject({
      provider, model, displayName: "Qwen4 Max", contextWindow: 1_000_000, maxContextWindow: 1_000_000,
      maxOutputTokens: 262_144, inputModalities: ["text", "image"], supportsToolUse: true,
      supportsParallelToolCalls: true, supportsStructuredOutput: false, supportsSearchTool: false,
      supportedReasoningLevels: efforts, defaultReasoningLevel: "high", visibility: "list",
    });
    expect(entry).not.toHaveProperty("retiresOn");
    expect(() => assertModelCatalogSelection({}, provider, model, {})).not.toThrow();
    expect(resolveProviderModelInput({}, provider, model)).toEqual({ provider, model });
    expect(modelCapabilityTags(provider, model)).toBe("vision · thinking");
  });

  it.each(providers)("lists it first on %s and keeps Qwen3.8 Max as the default", provider => {
    const listed = buildProviderModelCatalog({})[provider] ?? [];
    expect(listed[0]).toBe(model);
    expect(listed).toContain("qwen3.8-max");
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS[provider]).toBe("qwen3.8-max");
  });

  it("keeps the preview a Token Plan only model", () => {
    const catalog = buildProviderModelCatalog({});
    expect(catalog.qwen).not.toContain("qwen4-max-preview");
    expect(resolveRegisteredModelCatalogEntry({ provider: "qwen", model: "qwen4-max-preview" })).toBeUndefined();
    expect(() => new QwenProvider({ model: "qwen4-max-preview", apiKey: "fixture", fetchImpl: vi.fn() }))
      .toThrow(/Token Plan only/i);
    expect(resolveRegisteredModelCatalogEntry({ provider: "qwen-token-plan", model: "qwen4-max-preview" }))
      .toMatchObject({ displayName: "Qwen4 Max Preview", maxOutputTokens: 393_216, defaultReasoningLevel: "xhigh" });
  });

  it.each(providers)("reserves thinking and the answer together on %s", provider => {
    const metadata = new ModelMetadataResolver({ env: {} }).resolveSync({ provider, model, config: {} });
    expect(metadata).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 262_144, maxOutputTokensUpperLimit: 262_144 });
  });

  it.each(providers)("accepts images, thinking history and effort on %s", provider => {
    expect(resolveProviderModelCapabilities({ provider, model })).toMatchObject({
      supportsToolUse: true, supportsImageInput: true, acceptsImageHistory: true,
      supportsExtendedThinking: true, acceptsThinkingHistory: true, acceptsReasoningEffort: true,
    });
    expect(chatCompletionsCapabilityHintsForProvider(provider, model)).toMatchObject({
      replaysReasoningContent: true, preservesThinkingHistory: true,
    });
  });

  it.each(providers)("maps every effort to a documented value on %s", provider => {
    expect(resolveReasoningEffort({ provider, model })).toMatchObject({
      registered: true, acceptsChatEffort: true, levels: efforts, defaultLevel: "high",
    });
    const sent = { none: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "xhigh", max: "xhigh" } as const;
    for (const [effort, wire] of Object.entries(sent)) {
      const body = buildChatCompletionsRequest({ model, messages: [], tools: [],
        options: { reasoningEffort: effort as keyof typeof sent },
        providerCapabilityHints: chatCompletionsCapabilityHintsForProvider(provider, model) });
      expect(body.reasoning_effort).toBe(wire);
      expect(body).not.toHaveProperty("thinking_budget");
    }
    expect(resolveSessionReasoningEffort("max", efforts, { provider, model })).toBe("xhigh");
  });

  it.each(providers)("snapshots a default %s request with reasoning replay", async provider => {
    const { instance, fetchImpl, body } = fixture(provider);
    const messages: LLMMessage[] = [
      { role: "user", content: "Check." },
      { role: "assistant", content: "Checked.", providerReasoningContent: "Inspect the input.",
        providerReasoningProvenance: { provider, model } },
      { role: "user", content: "Continue." },
    ];
    const response = await instance.chat(messages, { reasoningEffort: "high" });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:1/compatible-mode/v1/chat/completions");
    expect(body()).toEqual({
      model, stream: false, max_completion_tokens: 262_144, preserve_thinking: true, reasoning_effort: "high",
      messages: [
        { role: "user", content: "Check." },
        { role: "assistant", content: "Checked.", reasoning_content: "Inspect the input." },
        { role: "user", content: "Continue." },
      ],
    });
    expect(response.providerReasoningContent).toBe("Check the result.");
    expect(response.providerReasoningProvenance).toEqual({ provider, model });
    expect(response.usage).toMatchObject({ promptTokens: 100, completionTokens: 20, reasoningOutputTokens: 15 });
  });

  it.each(providers)("honors explicit output caps and bounds oversized ones on %s", async provider => {
    const { instance, body } = fixture(provider, "qwen3.8-max");
    for (const maxOutputTokens of [8192, 262_144, 500_000]) {
      await instance.chat([{ role: "user", content: "OK" }], { model, maxOutputTokens });
      expect(body().max_completion_tokens).toBe(Math.min(maxOutputTokens, 262_144));
      expect(body()).not.toHaveProperty("max_tokens");
    }
    // Other Qwen models keep their own request: the Qwen4 default cap does not leak into them.
    await instance.chat([{ role: "user", content: "OK" }]);
    expect(body()).toMatchObject({ model: "qwen3.8-max", max_completion_tokens: 32_000 });
  });

  it.each(providers)("sends images and parallel tools on %s", async provider => {
    const { instance, body } = fixture(provider);
    const options: LLMChatOptions = { tools: [tool], toolChoice: "auto", parallelToolCalls: true, reasoningEffort: "low" };
    await instance.chat([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] }], options);
    expect(body()).toMatchObject({ tools: [tool], tool_choice: "auto", parallel_tool_calls: true, reasoning_effort: "low",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] }] });
  });

  it.each(providers)("streams tool calls and replays their thinking with the tool result on %s", async provider => {
    const { instance, fetchImpl, body } = fixture(provider);
    fetchImpl.mockImplementationOnce(async () => new Response([
      { choices: [{ index: 0, delta: { reasoning_content: "Call echo." } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "echo", arguments: '{"value":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
        completion_tokens_details: { reasoning_tokens: 15 } } },
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }));
    const messages: LLMMessage[] = [{ role: "user", content: "Call echo." }];
    const response = await instance.chatStream(messages, vi.fn(), { tools: [tool], reasoningEffort: "medium" });
    expect(body()).toMatchObject({ model, max_completion_tokens: 262_144, stream: true,
      stream_options: { include_usage: true }, reasoning_effort: "high" });
    expect(body()).not.toHaveProperty("tool_stream");
    expect(response.toolCalls).toMatchObject([{ id: "call-1", name: "echo", arguments: '{"value":"ok"}' }]);
    await instance.chat([...messages, { role: "assistant", content: response.content,
      toolCalls: response.toolCalls, providerReasoningContent: response.providerReasoningContent,
      providerReasoningProvenance: response.providerReasoningProvenance },
    { role: "tool", toolCallId: "call-1", content: "ok" }], { tools: [tool], reasoningEffort: "medium" });
    expect(body().messages[1]).toMatchObject({ reasoning_content: "Call echo.", tool_calls: [
      { id: "call-1", type: "function", function: { name: "echo", arguments: '{"value":"ok"}' } },
    ] });
    expect(body().messages[2]).toMatchObject({ role: "tool", tool_call_id: "call-1", content: "ok" });
  });

  it.each(providers)("turns thinking off for a forced tool choice on %s", async provider => {
    const { instance, body } = fixture(provider);
    await instance.chat([{ role: "user", content: "Call echo." }], { tools: [tool], toolChoice: "required", reasoningEffort: "xhigh" });
    expect(body()).toMatchObject({ tool_choice: "required", enable_thinking: false, max_completion_tokens: 262_144 });
    expect(body()).not.toHaveProperty("reasoning_effort");
    expect(body()).not.toHaveProperty("thinking_budget");
  });

  it.each(providers)("keeps JSON Schema requests on the provider-neutral fallback on %s", provider => {
    expect(resolveProviderStructuredOutputMode({ provider, model, api: "chat_completions" })).toBe("unsupported");
  });

  it.each(providers)("uses the Qwen tokenizer estimate and a strong routing prior on %s", provider => {
    expect(roughTokenCountEstimationForProvider("x".repeat(380), { provider, model })).toBe(100);
    expect(childModelProfile(provider, model)).toBe(childModelProfile(provider, "qwen3.8-max"));
  });

  it("prices Pay-As-You-Go at the Singapore rates and the Token Plan as plan usage", () => {
    const usage = { model, inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 400_000,
      cacheCreationInputTokens: 0, reasoningOutputTokens: 250_000, webSearchRequests: 0, totalTokens: 2_000_000, turns: 1 };
    expect(resolveModelCostEntry({ provider: "qwen", model }, DEFAULT_MODEL_COSTS)).toMatchObject({
      key: "qwen:qwen4-max",
      entry: { inputUsdPer1K: 0.0015, outputUsdPer1K: 0.0045, cachedInputUsdPer1K: 0.000075, cachedInputIncludedInInputTokens: true },
    });
    expect(resolveModelCostEntry({ provider: "qwen", model }, DEFAULT_MODEL_COSTS)?.entry).not.toHaveProperty("longContext");
    // 600k fresh input at $1.5, 400k cached at $0.075, 1M output (thinking included) at $4.5.
    const payg = computeUsdCostWithResolution({ provider: "qwen", ...usage }, DEFAULT_MODEL_COSTS);
    expect(payg.known).toBe(true);
    expect(payg.costUsd).toBeCloseTo(0.9 + 0.03 + 4.5, 6);
    expect(resolveModelCostEntry({ provider: "qwen-token-plan", model }, DEFAULT_MODEL_COSTS)).toMatchObject({
      entry: { inputUsdPer1K: 0, outputUsdPer1K: 0, label: "plan", localZeroCost: true },
    });
    expect(computeUsdCostWithResolution({ provider: "qwen-token-plan", ...usage }, DEFAULT_MODEL_COSTS))
      .toMatchObject({ known: true, costUsd: 0 });
  });

  it("rejects mismatched keys on the documented qwencloudapi.com endpoints", () => {
    const paygBase = "https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1";
    const planBase = "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1";
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => new QwenProvider({ model, apiKey: "sk-fixture", baseURL: paygBase, fetchImpl })).not.toThrow();
    expect(() => new QwenTokenPlanProvider({ model, apiKey: "sk-sp-fixture", baseURL: planBase, fetchImpl })).not.toThrow();
    expect(() => new QwenProvider({ model, apiKey: "sk-fixture", baseURL: planBase, fetchImpl }))
      .toThrow(/cannot use the qwen-token-plan endpoint/);
    expect(() => new QwenTokenPlanProvider({ model, apiKey: "sk-sp-fixture", baseURL: paygBase, fetchImpl }))
      .toThrow(/cannot use the qwen endpoint/);
    expect(() => new QwenTokenPlanProvider({ model, apiKey: "sk-sp-fixture",
      baseURL: "https://maas.qwencloudapi.com/compatible-mode/v1", fetchImpl })).toThrow(/cannot use the qwen endpoint/);
  });
});
