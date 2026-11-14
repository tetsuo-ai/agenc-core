import { describe, expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../../../src/llm/providers/deepseek/index.js";
import { deepSeekAppToolsEnabled } from "../../../../src/llm/providers/deepseek/app-tools.js";
import { buildChatCompletionsRequest, parseChatCompletionsResponse } from "../../../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../../src/llm/wire/capability-gating.js";
import { decodeDeepSeekWebReplay, deepSeekWebUsage, renderDeepSeekWebResponse, DeepSeekWebStream } from "../../../../src/llm/wire/deepseek-web-tools.js";
import { validateProviderConfig } from "../../../../src/config/schema.js";
import { llmMessageToResponseItem, responseItemToLlmMessage, durableProviderReplay } from "../../../../src/session/message-history-conversion.js";
import { redactDurableSecrets } from "../../../../src/session/provider-replay-redaction.js";
import { computeUsdCost, DEFAULT_MODEL_COSTS, CostSidecar } from "../../../../src/session/cost.js";
import type { LLMMessage, LLMTool } from "../../../../src/llm/types.js";
import { bodyAt, createSuccessfulChatResponse, sseResponse } from "../openai-compatible-test-helpers.js";
import { providerNativeToolsForAccounting } from "../../../../src/budget/admitted-model-call.js";

const model = "deepseek-flash";
const providerCapabilityHints = chatCompletionsCapabilityHintsForProvider("deepseek", model);
const functions: LLMTool[] = ["exec_command", "FileRead"].map(name => ({ type: "function", function: {
  name, description: name, parameters: { type: "object", properties: { path: { type: "string" } } },
} }));
const request = { model, messages: [{ role: "user", content: "Read https://example.com" }] as LLMMessage[],
  tools: functions, providerCapabilityHints, options: { deepSeekAppTools: true, maxOutputTokens: 1024 } };
const call = { index: 0, id: "srvtoolu_rl_00_fixture", type: "deepseek_read_url", kind: "read_link",
  action: { type: "read_link", url: "https://example.com" }, status: "completed",
  page: { url: "https://example.com", title: "Example", published_at: null }, signature: "YWJjZGVmZ2hpamtsbW5vcA==",
  future_provider_field: { untouched: [1, "two"] } };
const message = { role: "assistant", content: "🌍 Example page.", reasoning_content: "final step only",
  server_tool_calls: [{ index: 0, reasoning_content: "before reading", calls: [call] }],
  annotations: [{ type: "url_citation", url_citation: { url: "https://example.com", title: "Example", start_index: 0, end_index: 2 } }],
};
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 10 },
  server_tool_use: { tool_search: 2, tool_fetch: 1, tool_image_search: 3, web_search_requests: 99, web_fetch_requests: 88 } };
const response = { model, choices: [{ index: 0, message, finish_reason: "stop" }], usage };

describe("DeepSeek App tools", () => {
  test("requires both session web mode and an explicit native opt-in", () => {
    expect(deepSeekAppToolsEnabled("deepseek", model, {})).toBe(false);
    expect(deepSeekAppToolsEnabled("deepseek", model, { AGENC_WEB_SEARCH: "on" })).toBe(false);
    expect(deepSeekAppToolsEnabled("deepseek", model, { AGENC_DEEPSEEK_APP_TOOLS: "on" })).toBe(false);
    const config = { web_search: "on" as const, providers: { deepseek: { app_tools: true } } };
    expect(deepSeekAppToolsEnabled("deepseek", model, {}, config)).toBe(true);
    expect(deepSeekAppToolsEnabled("deepseek", model, { AGENC_DEEPSEEK_APP_TOOLS: "off" }, config)).toBe(false);
    expect(deepSeekAppToolsEnabled("deepseek", model, { AGENC_WEB_SEARCH: "auto" }, config)).toBe(false);
    for (const provider of ["openrouter", "qwen", "qwen-token-plan", "agenc"]) {
      expect(deepSeekAppToolsEnabled(provider, model, {}, config)).toBe(false);
    }
    expect(deepSeekAppToolsEnabled("deepseek", "deepseek-v4-pro", {}, config)).toBe(false);
  });

  test("validates the provider-only boolean setting", () => {
    expect(validateProviderConfig({ deepseek: { app_tools: true } })).toEqual({ deepseek: { app_tools: true } });
    expect(() => validateProviderConfig({ qwen: { app_tools: true } })).toThrow(/only under providers.deepseek/);
    expect(() => validateProviderConfig({ deepseek: { app_tools: "on" } })).toThrow();
  });

  test("declares server tools beside local functions and removes ignored controls", () => {
    const body = buildChatCompletionsRequest({ ...request, options: { ...request.options,
      temperature: 0.2, parallelToolCalls: true, stopSequences: ["stop"], toolChoice: "required" } });
    expect(body.tools).toHaveLength(4);
    expect(body.tools).toEqual(expect.arrayContaining([{ type: "deepseek_web_search" }, { type: "deepseek_read_url" }]));
    for (const key of ["preserve_thinking", "parallel_tool_calls", "temperature", "stop"]) expect(body).not.toHaveProperty(key);
    expect(body.tool_choice).toBe("auto");
    expect(body).toMatchSnapshot();
  });

  test("off remains byte-identical and foreign providers do not acquire tools", () => {
    const { deepSeekAppTools: _flag, ...options } = request.options;
    expect(JSON.stringify(buildChatCompletionsRequest({ ...request, options: { ...options, deepSeekAppTools: false } })))
      .toBe(JSON.stringify(buildChatCompletionsRequest({ ...request, options })));
    const body = buildChatCompletionsRequest({ ...request,
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("qwen-token-plan", "deepseek-v4.1-flash") });
    expect((body.tools as { type: string }[]).every(tool => tool.type === "function")).toBe(true);
  });

  test("accounts for server tools and exposes the per-step output limit to admission", async () => {
    const provider = new DeepSeekProvider({ apiKey: "test-only", model });
    expect((await provider.getExecutionProfile()).supportsMaxOutputTokens).toBe(true);
    expect((await provider.getExecutionProfile(request.options)).supportsMaxOutputTokens).toBe(false);
    expect(providerNativeToolsForAccounting(provider, "deepseek", model, {}, request.options)).toEqual([
      { name: "deepseek_web_search", toolType: "web_search", payload: { type: "deepseek_web_search" } },
      { name: "deepseek_read_url", toolType: "web_search", payload: { type: "deepseek_read_url" } },
    ]);
    expect(providerNativeToolsForAccounting(provider, "deepseek", model, {}, {})).toEqual([]);
    expect(providerNativeToolsForAccounting(provider, "deepseek", model, {}, { ...request.options, toolChoice: "none" })).toEqual([]);
  });

  test("rejects unsupported combinations locally and honors none", () => {
    expect(() => buildChatCompletionsRequest({ ...request, options: { ...request.options, disableThinkingForRecovery: true } }))
      .toThrow(/require thinking/);
    expect(() => buildChatCompletionsRequest({ ...request, options: { ...request.options,
      structuredOutput: { schema: { type: "json_schema", name: "result", schema: { type: "object" } } } } }))
      .toThrow(/require text/);
    expect(() => buildChatCompletionsRequest({ ...request, options: { ...request.options,
      toolChoice: { type: "function", name: "deepseek_web_search" } } })).toThrow(/cannot be forced/);
    expect(buildChatCompletionsRequest({ ...request, options: { ...request.options, toolChoice: "none" } }).tool_choice).toBe("none");
  });

  test("keeps exact wire blocks through durable history and displays Unicode citations separately", () => {
    const parsed = parseChatCompletionsResponse(model, response, request);
    expect(parsed.content).toContain("Read page: https://example.com");
    expect(parsed.content).toContain("🌍  [1]Example page.");
    expect(parsed.content).toContain("[Example](<https://example.com/>)");
    expect(parsed.content).not.toContain(call.signature);
    expect(decodeDeepSeekWebReplay(parsed.providerReasoningContent)).toEqual({
      content: message.content, reasoning_content: message.reasoning_content,
      server_tool_calls: message.server_tool_calls, annotations: message.annotations,
    });
    const history: LLMMessage = { role: "assistant", content: parsed.content,
      providerReasoningContent: parsed.providerReasoningContent, providerReasoningProvenance: parsed.providerReasoningProvenance };
    const item = llmMessageToResponseItem(history);
    const restored = responseItemToLlmMessage(JSON.parse(JSON.stringify(item)));
    const body = buildChatCompletionsRequest({ ...request, messages: [...request.messages, restored, { role: "user", content: "Continue" }] });
    expect((body.messages as object[])[1]).toEqual(message);
    // Turning App tools off still replays signed history to the same native model.
    expect(buildChatCompletionsRequest({ ...request, options: {}, messages: [...request.messages, restored] }).messages)
      .toEqual([request.messages[0], message]);
    const foreign = buildChatCompletionsRequest({ ...request, messages: [restored],
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("qwen-token-plan", model) });
    expect(JSON.stringify(foreign)).not.toContain(call.signature);
  });

  test("bills provider counts, including fetch/image units, once through cost tracking", () => {
    const parsed = parseChatCompletionsResponse(model, response, request);
    expect(parsed.usage.webSearchRequests).toBe(6);
    expect(parsed.providerEvidence?.serverSideToolUsage?.map(row => row.count)).toEqual([2, 1, 3]);
    const cost = computeUsdCost({ model, provider: "deepseek", inputTokens: 100, outputTokens: 20,
      cachedInputTokens: 64, cacheCreationInputTokens: 0, reasoningOutputTokens: 10,
      webSearchRequests: parsed.usage.webSearchRequests!, totalTokens: 120, turns: 1 }, DEFAULT_MODEL_COSTS);
    expect(cost).toBeCloseTo((36 * 0.3 + 64 * 0.006 + 20 * 1.2) / 1e6 + 6 * 0.00075, 12);
    const sidecar = new CostSidecar({ defaultProvider: "deepseek", defaultModel: model, exitSummary: false });
    sidecar.onEvent({ id: "web-usage", seq: 1, msg: { type: "token_count", payload: { ...parsed.usage, model, provider: "deepseek" } } });
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(cost, 12);
    expect(sidecar.getTotalWebSearchRequests()).toBe(6);
    expect(deepSeekWebUsage({ server_tool_use: { tool_search: -1, tool_fetch: NaN, tool_image_search: "4", web_search_requests: 99 } })?.count).toBe(0);
    expect(deepSeekWebUsage({})).toBeUndefined();
  });

  test("does not turn source URLs into unsafe links", () => {
    expect(renderDeepSeekWebResponse({ content: "Answer", annotations: [
      { type: "url_citation", url_citation: { url: "javascript:alert(1)", title: "click", start_index: 0, end_index: 6 } },
    ] })).toBe("Answer");
  });

  test("preserves ciphertext during durable redaction but never hides text secrets", () => {
    const parsed = parseChatCompletionsResponse(model, response, request);
    const item = llmMessageToResponseItem({ role: "assistant", content: parsed.content,
      providerReasoningContent: parsed.providerReasoningContent, providerReasoningProvenance: parsed.providerReasoningProvenance });
    const redact = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(call.signature, "[redacted]"));
    expect(redactDurableSecrets(item, "response", redact)).toEqual(item);
    expect(durableProviderReplay(item.providerReasoning, redact)).toEqual(item.providerReasoning);
    const redactText = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll("before reading", "[redacted]"));
    expect(durableProviderReplay(item.providerReasoning, redactText)).toBeUndefined();
  });

  test("streaming keeps only final-step reasoning in replay and never dispatches server calls", async () => {
    const frame = (delta: object, finish_reason: string | null = null, server_tool_event?: object) =>
      `data: ${JSON.stringify({ model, choices: [{ index: 0, delta, finish_reason, server_tool_event }], ...(finish_reason ? { usage } : {}) })}\n\n`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(sseResponse([
      frame({ reasoning_content: "before reading" }),
      frame({}, null, { type: "step_reasoning_done", step: 0 }),
      frame({}, null, { type: "call_started", step: 0, call }),
      frame({}, null, { type: "call_completed", step: 0, call: { ...call, signature: undefined } }),
      frame({ reasoning_content: message.reasoning_content }), frame({ content: message.content }),
      frame({ server_tool_calls: message.server_tool_calls, annotations: message.annotations }, "stop"), "data: [DONE]\n\n",
    ])).mockResolvedValueOnce(createSuccessfulChatResponse("next")(model, "Done"));
    const provider = new DeepSeekProvider({ apiKey: "test-only", model, fetchImpl });
    const chunks: string[] = [];
    const parsed = await provider.chatStream(request.messages, chunk => chunks.push(chunk.content), { ...request.options, tools: functions });
    expect(parsed.toolCalls).toEqual([]);
    expect(chunks.join("")).toContain("Read page");
    expect(parsed.thinking?.[0]?.text).toBe("before readingfinal step only");
    expect(decodeDeepSeekWebReplay(parsed.providerReasoningContent)?.reasoning_content).toBe("final step only");
    expect(parsed.usage.webSearchRequests).toBe(6);
    await provider.chat([...request.messages, { role: "assistant", content: parsed.content,
      providerReasoningContent: parsed.providerReasoningContent, providerReasoningProvenance: parsed.providerReasoningProvenance },
      { role: "user", content: "Continue" }], { ...request.options, tools: functions });
    expect((bodyAt(fetchImpl, 1).messages as object[])[1]).toEqual(message);
  });

  test("preserves omitted non-thinking reasoning and known-empty function continuation", () => {
    const stream = new DeepSeekWebStream();
    stream.push({ server_tool_event: { type: "step_reasoning_done", step: 0 } }, {});
    stream.push({}, { server_tool_calls: message.server_tool_calls });
    expect(stream.messageFields()).not.toHaveProperty("reasoning_content");
    const parsed = parseChatCompletionsResponse(model, { model, choices: [{
      finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [
        { id: "call_empty", type: "function", function: { name: "FileRead", arguments: '{"path":"README.md"}' } },
      ] },
    }], usage }, request);
    expect(decodeDeepSeekWebReplay(parsed.providerReasoningContent)?.reasoning_content).toBe("");
    const body = buildChatCompletionsRequest({ ...request, messages: [...request.messages, {
      role: "assistant", content: parsed.content, toolCalls: parsed.toolCalls,
      providerReasoningContent: parsed.providerReasoningContent, providerReasoningProvenance: parsed.providerReasoningProvenance,
    }, { role: "tool", toolCallId: "call_empty", content: "README contents" }] });
    expect((body.messages as Record<string, unknown>[])[1]?.reasoning_content).toBe("");
  });

  test("keeps paid usage on in-band generation errors and clears refused streamed text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(sseResponse([
      `data: ${JSON.stringify({ model, choices: [], error: { message: "generation failed" }, usage })}\n\n`,
    ])).mockResolvedValueOnce(sseResponse([
      `data: ${JSON.stringify({ model, choices: [{ delta: { content: "Withdraw this", reasoning_content: "Withdraw reasoning" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ model, choices: [{ delta: { content: "", server_tool_calls: [] }, finish_reason: "content_filter" }], usage })}\n\n`,
      "data: [DONE]\n\n",
    ]));
    const provider = new DeepSeekProvider({ apiKey: "test-only", model, fetchImpl });
    const failed = await provider.chatStream(request.messages, () => {}, request.options);
    expect(failed.finishReason).toBe("error");
    expect(failed.error).toBeInstanceOf(Error);
    expect(failed.usage.webSearchRequests).toBe(6);
    const refused = await provider.chatStream(request.messages, () => {}, request.options);
    expect(refused.content).not.toContain("Withdraw");
    expect(refused.content).toContain("declined");
    expect(refused.thinking).toBeUndefined();
    const jsonRefusal = parseChatCompletionsResponse(model, { ...response,
      choices: [{ message, finish_reason: "content_filter" }],
    }, request);
    expect(jsonRefusal.content).not.toContain(message.content);
    expect(jsonRefusal.thinking).toBeUndefined();
    expect(decodeDeepSeekWebReplay(jsonRefusal.providerReasoningContent)?.annotations).toEqual([]);
    const jsonError = parseChatCompletionsResponse(model, { error: { message: "failed" }, usage }, request);
    expect(jsonError.finishReason).toBe("error");
    expect(jsonError.usage.webSearchRequests).toBe(6);
  });
});
