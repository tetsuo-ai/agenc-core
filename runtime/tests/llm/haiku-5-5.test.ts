import { describe, expect, it, vi } from "vitest";
import { sanitizeModelName } from "../../src/utils/commitAttribution.js";
import { defaultConfig } from "../../src/config/schema.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";
import { isCanonicalEventPayload } from "../../src/state/recovery-journal-schema.js";
import { parseClaudeModelId } from "../../src/utils/model/claudeModelId.js";
import { AGENC_HAIKU_5_5_CONFIG } from "../../src/utils/model/configs.js";
import { firstPartyNameToCanonical, getMarketingNameForModel } from "../../src/utils/model/model.js";
import { anthropicThinkingControl, anthropicEffortLevels, anthropicAcceptsSamplingParameters } from "../../src/utils/model/anthropicThinkingControl.js";
import { modelSupportsAdaptiveThinking } from "../../src/utils/thinking.js";
import { childModelProfile } from "../../src/agents/provider-selector-profiles.js";
import { resolveRegisteredModelCatalogEntry } from "../../src/llm/registry/model-catalog.js";
import { BUILT_IN_PROVIDER_DEFAULT_MODELS, BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../src/llm/registry/provider-info.js";
import { resolveSessionReasoningEffort } from "../../src/session/session-reasoning-effort.js";
import { buildAnthropicMessagesRequest, parseAnthropicMessagesResponse } from "../../src/llm/wire/messages-anthropic.js";
import { anthropicSupportsFastMode } from "../../src/llm/providers/anthropic/fast-mode.js";
import { getTokenizerConfigForProvider, roughTokenCountEstimationForProvider } from "../../src/llm/token-estimation.js";
import { calculateUSDCost, getModelCosts, getModelPricingString } from "../../src/utils/modelCost.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS } from "../../src/session/cost.js";
import { BedrockProvider } from "../../src/llm/providers/bedrock/index.js";
import { AnthropicProvider } from "../../src/llm/providers/anthropic/adapter.js";
import { createTokenAccountingRequest } from "../../src/llm/token-accounting.js";
import type { LLMChatOptions, LLMMessage, LLMTool } from "../../src/llm/types.js";

const model = "claude-haiku-5-5";
const levels = ["low", "medium", "high", "xhigh", "max"] as const;
const messages: LLMMessage[] = [{ role: "user", content: "Hello" }];
const tools: LLMTool[] = [{ type: "function", function: { name: "echo", description: "Echo", parameters: { type: "object", properties: {} } } }];
const build = (options?: LLMChatOptions) => buildAnthropicMessagesRequest({ model, messages, tools, options, maxTokens: 512 });
const usage = { input_tokens: 60_000, output_tokens: 1000, cache_read_input_tokens: 20_000,
  cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 10_000 } };
const responseBody = { model, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage };
function sse(): Response {
  const events = [
    { type: "message_start", message: { ...responseBody, content: [], usage: { ...usage, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1000 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

describe("Claude Haiku 5.5", () => {
  it.each([model, "anthropic.claude-haiku-5-5", "anthropic/claude-haiku-5.5"])("reads %s as the exact generation", id => {
    expect(parseClaudeModelId(id)).toMatchObject({ family: "haiku", major: 5, minor: 5, canonical: model });
    expect(firstPartyNameToCanonical(id)).toBe(model);
    expect(anthropicThinkingControl(id)).toBe("adaptive");
    expect(anthropicEffortLevels(id)).toEqual(levels);
    expect(anthropicAcceptsSamplingParameters(id)).toBe(false);
    expect(anthropicSupportsFastMode(id)).toBe(false);
    expect(modelSupportsAdaptiveThinking(id)).toBe(true);
  });
  it("keeps IDs, defaults, legacy rows and selector priors distinct", () => {
    expect(AGENC_HAIKU_5_5_CONFIG).toMatchObject({ firstParty: model, bedrock: `anthropic.${model}`, vertex: model });
    expect(parseClaudeModelId("claude-haiku-5")?.canonical).toBe("claude-haiku-5");
    expect(parseClaudeModelId("claude-haiku-5-50")?.canonical).toBe("claude-haiku-5-50");
    expect(getMarketingNameForModel(model)).toBe("Haiku 5.5");
    expect(sanitizeModelName(model)).toBe(model);
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.anthropic).toBe("claude-opus-5-5");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.anthropic.indexOf(model)).toBeLessThan(BUILT_IN_PROVIDER_MODEL_CATALOG.anthropic.indexOf("claude-haiku-4-5-20251001"));
    expect(childModelProfile("anthropic", model)).toEqual(childModelProfile("anthropic", "claude-haiku-4-5"));
    expect(childModelProfile("anthropic", model)?.latencyMs).toBe(8000);
    expect(resolveRegisteredModelCatalogEntry({ provider: "anthropic", model: "claude-haiku-4-5" })).toMatchObject({ contextWindow: 200_000, supportedReasoningLevels: [] });
  });
  it.each([["anthropic", model], ["amazon-bedrock", `anthropic.${model}`], ["openrouter", "anthropic/claude-haiku-5.5"]])("registers the %s contract", (provider, id) => {
    const row = resolveRegisteredModelCatalogEntry({ provider, model: id });
    expect(row).toMatchObject({ contextWindow: 1_000_000,
      ...(provider === "openrouter" ? { maxOutputTokens: 128_000 } : { maxOutputTokensUpperLimit: 128_000 }),
      inputModalities: ["text", "image"], defaultReasoningLevel: "medium", additionalSpeedTiers: [] });
    expect([...row!.supportedReasoningLevels].sort()).toEqual([...levels].sort());
  });
  it("exposes the registered limits and efforts to the model picker", async () => {
    const manager = new StaticModelsManager({ config: defaultConfig(), fallbackProvider: "anthropic" });
    expect(await manager.getModelInfo(model)).toMatchObject({ contextWindow: 1_000_000,
      maxOutputTokensUpperLimit: 128_000, supportedReasoningLevels: levels, usedFallbackModelMetadata: false });
  });
  it.each([undefined, ...levels])("sends summarized adaptive thinking at effort %s with no manual budget, sampling or priority", reasoningEffort => {
    const body = build({ reasoningEffort, temperature: 0.2, serviceTier: "priority", toolChoice: "required" });
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual(reasoningEffort ? { effort: reasoningEffort } : undefined);
    expect(body.tool_choice).toEqual({ type: "any" });
    for (const field of ["temperature", "top_p", "top_k", "speed", "service_tier"]) expect(body).not.toHaveProperty(field);
  });
  it.each(["anthropic", "amazon-bedrock"])("preserves thinking off for %s at the default medium effort", provider => {
    const id = provider === "anthropic" ? model : `anthropic.${model}`;
    const reasoningEffort = resolveSessionReasoningEffort("none", levels, { provider, model: id });
    expect(reasoningEffort).toBe("none");
    expect(build({ reasoningEffort }).thinking).toEqual({ type: "disabled" });
    expect(build({ reasoningEffort }).output_config).toBeUndefined();
  });
  it("accepts a named forced tool and parses a response without thinking", () => {
    expect(build({ reasoningEffort: "max", toolChoice: { type: "function", name: "echo" } }).tool_choice).toEqual({ type: "tool", name: "echo" });
    const response = parseAnthropicMessagesResponse(model, { ...responseBody,
      content: [{ type: "tool_use", id: "t", name: "echo", input: {} }], stop_reason: "tool_use" }, { model, messages, tools });
    expect(response.toolCalls?.[0]?.name).toBe("echo");
    expect(response.thinking).toBeUndefined();
  });
  it.each(["summary", "compaction", "title", "classifier", "side question"])("converts a %s prefill to a user continuation", purpose => {
    const original: LLMMessage[] = [...messages, { role: "assistant", content: `Start ${purpose}:` }];
    const body = buildAnthropicMessagesRequest({ model, messages: original, tools: [], options: { reasoningEffort: "none" } });
    expect((body.messages as { role: string }[]).at(-1)?.role).toBe("user");
    expect(original.at(-1)?.role).toBe("assistant");
    expect(JSON.stringify(body)).toContain(`Start ${purpose}:`);
  });
  it.each(["system edit", "tool edit", "compaction", "history edit", "tool result clearing"])("never replays signed thinking after %s", edit => {
    const response = parseAnthropicMessagesResponse(model, { ...responseBody, content: [
      { type: "thinking", thinking: "private reasoning", signature: "prefix-bound" },
      { type: "redacted_thinking", data: "opaque-data" },
      { type: "tool_use", id: "t", name: "echo", input: {} },
    ], stop_reason: "tool_use" }, { model, messages, tools });
    expect(response.thinking).toHaveLength(2);
    expect(response.providerReasoningContent).toBeUndefined();
    const body = buildAnthropicMessagesRequest({ model, tools: edit === "tool edit" ? [] : tools, messages: [
      { role: "system", content: edit }, { role: "user", content: edit },
      { role: "assistant", content: response.content, toolCalls: response.toolCalls },
      { role: "tool", toolCallId: "t", content: edit },
    ] });
    for (const text of ["prefix-bound", "private reasoning", "opaque-data"]) expect(JSON.stringify(body)).not.toContain(text);
  });
  it("journals the one-hour write subset", () => {
    expect(isCanonicalEventPayload("token_count", { cacheCreationInputTokens: 20_000, cacheCreation1hInputTokens: 10_000 })).toBe(true);
    expect(isCanonicalEventPayload("token_count", { cacheCreation1hInputTokens: "invalid" })).toBe(false);
  });
  it("maps refusal through the same finish-reason contract as other 5.x models", () => {
    expect(parseAnthropicMessagesResponse(model, { ...responseBody, stop_reason: "refusal" }, { model, messages, tools }).finishReason).toBe("content_filter");
  });
  it("estimates the newer tokenizer consistently across supported platform IDs", () => {
    const old = roughTokenCountEstimationForProvider("a".repeat(3500), { model: "claude-haiku-4-5" });
    for (const id of [model, `anthropic.${model}`, "anthropic/claude-haiku-5.5", "claude-opus-5-5", "claude-sonnet-5-5"]) {
      expect(getTokenizerConfigForProvider({ model: id }).modelFamily).toBe("anthropic-new");
      const estimate = roughTokenCountEstimationForProvider("a".repeat(3500), { model: id });
      expect(estimate).toBeGreaterThanOrEqual(old * 1.3);
      expect(estimate).toBeLessThanOrEqual(old * 1.3 + 1);
    }
  });
  it.each([99_999, 100_000, 100_001])("prices all token categories at the %i prompt boundary in both calculators", prompt => {
    const u = { ...usage, input_tokens: prompt - 40_000 };
    const factor = prompt > 100_000 ? 5 : 1;
    const expected = factor * (u.input_tokens * 0.1 + 1000 * 0.5 + 20_000 * 0.01 + 10_000 * 0.125 + 10_000 * 0.2) / 1e6;
    for (const id of [model, `anthropic.${model}`, "anthropic/claude-haiku-5.5"]) {
      expect(calculateUSDCost(id, u as Parameters<typeof calculateUSDCost>[1])).toBeCloseTo(expected, 10);
      const result = computeUsdCostWithResolution({ model: id, provider: "anthropic", inputTokens: u.input_tokens,
        outputTokens: 1000, cachedInputTokens: 20_000, cacheCreationInputTokens: 20_000, cacheCreation1hInputTokens: 10_000,
        totalTokens: prompt + 1000, reasoningOutputTokens: 0, webSearchRequests: 0, turns: 1, singleCall: true }, DEFAULT_MODEL_COSTS);
      expect(result.known).toBe(true);
      expect(result.costUsd).toBeCloseTo(expected, 10);
    }
  });
  it("does not lend Haiku 5.5 prices to unknown minors or change Haiku 4.5", () => {
    const u = usage as Parameters<typeof getModelCosts>[1];
    expect(getModelPricingString(model)).toContain("100K");
    expect(getModelCosts("claude-haiku-4-5", u).inputTokens).toBe(1);
    expect(getModelCosts("claude-haiku-5-50", u).inputTokens).not.toBe(0.1);
    expect(resolveRegisteredModelCatalogEntry({ provider: "anthropic", model: "claude-haiku-5-50" })).toBeUndefined();
  });
  it.each([false, true])("keeps one-hour cache usage in the real Anthropic adapter (stream=%s)", async stream => {
    const provider = new AnthropicProvider({ model, apiKey: "test", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(stream ? sse() : Response.json(responseBody)) });
    const response = stream ? await provider.chatStream(messages, () => {}, { singleWireAttempt: true }) : await provider.chat(messages, { singleWireAttempt: true });
    expect(response.usage.cacheCreation1hInputTokens).toBe(10_000);
  });
  it.each([403, 429])("retains Bedrock HTTP %s classification on the Messages route", async status => {
    const provider = new BedrockProvider({ model: `anthropic.${model}`, accessKeyId: "test-id", secretAccessKey: "test-secret",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { type: status === 403 ? "permission_error" : "rate_limit_error", message: "test rejection" } }, { status })) });
    await expect(provider.chat(messages, { singleWireAttempt: true })).rejects.toMatchObject({ status });
  });
  it.each(["chat", "stream", "count"])("uses signed Bedrock Messages for %s", async method => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(method === "stream" ? sse() : Response.json(method === "count" ? { input_tokens: 100_000 } : responseBody));
    const provider = new BedrockProvider({ model: `anthropic.${model}`, region: "us-east-1", accessKeyId: "test-id", secretAccessKey: "test-secret", sessionToken: "test-token", fetchImpl });
    const options: LLMChatOptions = { reasoningEffort: "max", temperature: 0.1, tools, toolChoice: "required", serviceTier: "priority", singleWireAttempt: true };
    if (method === "count") await provider.tokenCountCapability.countTokens(createTokenAccountingRequest({ provider: provider.name, model: `anthropic.${model}`, messages, options, reservedOutputTokens: 512 }), new AbortController().signal);
    else if (method === "stream") await provider.chatStream(messages, () => {}, options);
    else await provider.chat(messages, options);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages${method === "count" ? "/count_tokens" : ""}`);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toContain("/us-east-1/bedrock-mantle/aws4_request");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-amz-security-token")).toBe("test-token");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: `anthropic.${model}`, output_config: { effort: "max" }, thinking: { type: "adaptive", display: "summarized" }, tool_choice: { type: "any" } });
    for (const field of ["temperature", "speed", "service_tier", "inferenceConfig"]) expect(body).not.toHaveProperty(field);
  });
});
