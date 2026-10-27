import { describe, expect, test, vi } from "vitest";
import { KimiProvider } from "../../src/llm/providers/kimi/index.js";
import { KIMI_CHAT_MODELS, isKimiK3Model } from "../../src/llm/registry/kimi-models.js";
import { OpenRouterProvider } from "../../src/llm/providers/openrouter/index.js";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER } from "../../src/llm/wire/shared.js";
import { lightEditsWithApplyPatch, lightUsesBatchEdit } from "../../src/tools/light-profile.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../../src/session/cost.js";
import type { LLMMessage, LLMTool } from "../../src/llm/types.js";
import { runWithStartupProviderSelection } from "../../src/utils/model/providers.js";
import { bodyAt, sseResponse } from "./providers/openai-compatible-test-helpers.js";

const tool: LLMTool = { type: "function", function: {
  name: "FileRead", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } },
} };
const routes = [
  ...KIMI_CHAT_MODELS.map(model => ["kimi", model] as const),
  ["openrouter", "moonshotai/kimi-k3"],
] as const;

describe.each(routes)("%s %s harness", (providerName, model) => {
  test.each([false, true])("replays reasoning and pairs parallel results when response ids restart, stream=%s", async (stream) => {
    const reasoningField = providerName === "kimi" ? "reasoning_content" : "reasoning";
    const reply = () => {
      const message = { role: "assistant", content: "", [reasoningField]: "Inspect both files before editing.", tool_calls: [0, 1].map(index => ({
        index, id: `FileRead:${index}`, type: "function", function: { name: "FileRead", arguments: JSON.stringify({ path: `${index}.txt` }) },
      })) };
      return stream ? sseResponse([
        `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`,
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]) : new Response(JSON.stringify({ model, choices: [{ message, finish_reason: "tool_calls" }] }), { headers: { "content-type": "application/json" } });
    };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => reply());
    const config = { model, apiKey: "test-key", fetchImpl, tools: [tool] };
    const provider = providerName === "kimi" ? new KimiProvider(config) : new OpenRouterProvider(config);
    const messages: LLMMessage[] = [{ role: "user", content: "Read both files, then read them again." }];
    const run = () => stream ? provider.chatStream(messages, () => undefined, { parallelToolCalls: true, reasoningEffort: "high" }) : provider.chat(messages, { parallelToolCalls: true, reasoningEffort: "high" });
    const first = await run();
    expect(first.toolCalls).toHaveLength(2);
    messages.push({ role: "assistant", content: first.content, toolCalls: first.toolCalls,
      providerReasoningContent: first.providerReasoningContent, providerReasoningProvenance: first.providerReasoningProvenance });
    for (const call of first.toolCalls!) messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: "file content" });
    const second = await run();
    expect(second.toolCalls).toHaveLength(2);
    expect(new Set([...first.toolCalls!, ...second.toolCalls!].map(call => call.id)).size).toBe(4);
    const body = bodyAt(fetchImpl, 1);
    const history = body.messages as Record<string, unknown>[];
    expect(history.find(m => m.role === "assistant")).toMatchObject({ [reasoningField]: "Inspect both files before editing." });
    expect(history.filter(m => m.role === "tool").map(m => m.tool_call_id)).toEqual(first.toolCalls!.map(call => call.id));
    // Both routes emit multiple calls without an optional parallel control.
    expect(body.parallel_tool_calls).toBeUndefined();
    if (providerName === "kimi") {
      if (isKimiK3Model(model)) {
        expect(body.reasoning_effort).toBe("high");
        expect(body.max_completion_tokens).toBe(131_072);
        expect(body).not.toHaveProperty("thinking");
      } else {
        expect(body).not.toHaveProperty("reasoning_effort");
        expect(body.max_completion_tokens).toBe(32_768);
        if (model === "kimi-k2.6") {
          expect(body.thinking).toEqual({ type: "enabled", keep: "all" });
        } else {
          expect(body).not.toHaveProperty("thinking");
        }
      }
      expect(body).not.toHaveProperty("temperature");
    }
  });

  test("keeps the cacheable head stable and the Light editor family consistent", () => {
    const request = (directory: string) => buildChatCompletionsRequest({ model, tools: [tool], messages: [{ role: "user", content: "Fix the code" }],
      options: { systemPrompt: `Stable instructions\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}\nWorking directory: ${directory}` },
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider(providerName, model) });
    const a = request("/project/a");
    const b = request("/project/b");
    expect((a.messages as unknown[])[0]).toEqual((b.messages as unknown[])[0]);
    expect(JSON.stringify(a.messages)).toContain("/project/a");
    expect(JSON.stringify(b.messages)).toContain("/project/b");
    expect(lightEditsWithApplyPatch(providerName, model)).toBe(false);
    expect(lightUsesBatchEdit(providerName, model)).toBe(false);
  });
});

test.each([false, true])("Moonshot cache writes are reported without double counting, stream=%s", async (stream) => {
  const model = "kimi-k3.1-pro";
  const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 } };
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stream ? sseResponse([
    'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
    `data: ${JSON.stringify({ choices: [], usage })}\n\n`, 'data: [DONE]\n\n',
  ]) : new Response(JSON.stringify({ model, choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage }), { headers: { "content-type": "application/json" } }));
  const provider = new KimiProvider({ model, apiKey: "test-key", fetchImpl });
  const messages: LLMMessage[] = [{ role: "user", content: "Go" }];
  const result = await (stream ? provider.chatStream(messages, () => undefined) : provider.chat(messages));
  expect(result.usage).toMatchObject({ promptTokens: 100, cachedInputTokens: 60, cacheCreationInputTokens: 30, cacheWritesUnreported: false });
  expect(resolveModelCostEntry({ provider: "kimi", model }, DEFAULT_MODEL_COSTS)).not.toBeNull();
  const cost = computeUsdCostWithResolution({ model, provider: "kimi",
    inputTokens: result.usage.promptTokens, outputTokens: result.usage.completionTokens,
    cachedInputTokens: result.usage.cachedInputTokens!, cacheCreationInputTokens: result.usage.cacheCreationInputTokens!,
    reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: result.usage.totalTokens, turns: 1,
  }, DEFAULT_MODEL_COSTS);
  expect(cost.known).toBe(true);
  expect(cost.costUsd).toBeCloseTo(0.000142, 9);
});

test.each([
  ["kimi-k3.1-pro", 0.000142],
  ["kimi-k3.1-pro-highspeed", 0.000272],
  ["kimi-k3", 0.000213],
])("native pricing includes cached input and default cache writes once: %s", (model, expected) => {
  const result = computeUsdCostWithResolution({
    model, provider: "kimi", inputTokens: 100, outputTokens: 5,
    cachedInputTokens: 60, cacheCreationInputTokens: 30,
    reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: 105, turns: 1,
  }, DEFAULT_MODEL_COSTS);
  expect(result.known).toBe(true);
  expect(result.costUsd).toBeCloseTo(expected, 9);
});

test.each([false, true])("bills the returned cache TTL even when a later request asks for 5m, stream=%s", async stream => {
  const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
    prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 } };
  const response = stream ? sseResponse([
    'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
    `data: ${JSON.stringify({ choices: [], usage })}\n\n`, 'data: [DONE]\n\n',
  ]) : Response.json({ choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage });
  response.headers.set("Msh-Usage-Cache-Write-Tokens-5m", "10");
  response.headers.set("Msh-Usage-Cache-Write-Tokens-1h", "20");
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
  const provider = new KimiProvider({ model: "kimi-k3.1-pro", apiKey: "test-key", fetchImpl });
  const messages: LLMMessage[] = [{ role: "user", content: "Go" }];
  const options = { promptCacheTtl: "5m" as const, promptCacheKey: "stable-task" };
  const result = await (stream ? provider.chatStream(messages, () => undefined, options) : provider.chat(messages, options));
  expect(bodyAt(fetchImpl)).toMatchObject({ prompt_cache_key: "stable-task", prompt_cache_options: { mode: "implicit", ttl: "5m" } });
  expect(result.usage).toMatchObject({ promptTokens: 100, cacheCreationInputTokens: 30, cacheCreation1hInputTokens: 20 });
  const cost = computeUsdCostWithResolution({
    model: "kimi-k3.1-pro", provider: "kimi", inputTokens: 100, outputTokens: 5,
    cachedInputTokens: 60, cacheCreationInputTokens: 30, cacheCreation1hInputTokens: 20,
    reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: 105, turns: 1,
  }, DEFAULT_MODEL_COSTS);
  expect(cost.costUsd).toBeCloseTo(0.000182, 9);
});

test.each(KIMI_CHAT_MODELS)("cache controls follow the documented family contract: %s", model => {
  const request = (ttl?: "5m" | "1h") => buildChatCompletionsRequest({ model, tools: [],
    messages: [{ role: "user", content: "Go" }], options: { promptCacheKey: "resumed-session", promptCacheTtl: ttl },
    providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("kimi", model) });
  expect(request()).not.toHaveProperty("prompt_cache_options");
  for (const ttl of ["5m", "1h"] as const) {
    expect(request(ttl).prompt_cache_options).toEqual(isKimiK3Model(model) ? { mode: "implicit", ttl } : undefined);
    expect(request(ttl).prompt_cache_key).toBe("resumed-session");
  }
});

test("cache TTL is taken from the bound client environment, with request overrides", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  const model = "kimi-k3.1-pro";
  const provider = new KimiProvider({ model, apiKey: "test-key", fetchImpl });
  const run = (ttl: string, override?: "5m") => runWithStartupProviderSelection(
    { provider: "kimi", model, environment: { AGENC_KIMI_CACHE_TTL: ttl } },
    () => provider.chat([{ role: "user", content: "Go" }], { promptCacheTtl: override }),
  );
  await run("1h");
  expect(bodyAt(fetchImpl).prompt_cache_options).toEqual({ mode: "implicit", ttl: "1h" });
  await run("1h", "5m");
  expect(bodyAt(fetchImpl, 1).prompt_cache_options).toEqual({ mode: "implicit", ttl: "5m" });
  await expect(run("24h")).rejects.toThrow("AGENC_KIMI_CACHE_TTL must be 5m or 1h");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test.each([
  ["kimi-k3.1-pro", 0.000202], ["kimi-k3.1-pro-highspeed", 0.000392], ["kimi-k3", 0.000303],
])("one-hour writes use the published rate without double counting: %s", (model, expected) => {
  const cost = computeUsdCostWithResolution({ model, provider: "kimi", inputTokens: 100, outputTokens: 5,
    cachedInputTokens: 60, cacheCreationInputTokens: 30, cacheCreation1hInputTokens: 30,
    reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: 105, turns: 1,
  }, DEFAULT_MODEL_COSTS);
  expect(cost.costUsd).toBeCloseTo(expected, 9);
});

test("stop limits count UTF-8 bytes and reject invalid requests before HTTP", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  const provider = new KimiProvider({ model: "kimi-k3.1-pro", apiKey: "test-key", fetchImpl });
  const messages: LLMMessage[] = [{ role: "user", content: "Go" }];
  await provider.chat(messages, { stopSequences: ["é".repeat(16), "END"] });
  expect(bodyAt(fetchImpl).stop).toEqual(["é".repeat(16), "END"]);
  await expect(provider.chat(messages, { stopSequences: ["é".repeat(17)] })).rejects.toThrow("32 UTF-8 bytes");
  await expect(provider.chatStream(messages, () => undefined, { stopSequences: Array(6).fill("END") })).rejects.toThrow("five stop sequences");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test.each(KIMI_CHAT_MODELS)("separates tool work from final schema generation: %s", async model => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ model, choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: "", reasoning_content: "Read the file first.",
      tool_calls: [{ id: "read_0", type: "function", function: { name: "FileRead", arguments: '{"path":"x"}' } }],
    } }] }))
    .mockResolvedValueOnce(Response.json({ model, choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }));
  const provider = new KimiProvider({ model, apiKey: "test-key", fetchImpl, tools: [tool] });
  const messages: LLMMessage[] = [{ role: "user", content: "Read x then return JSON." }];
  const first = await provider.chat(messages);
  messages.push({ role: "assistant", content: first.content, toolCalls: first.toolCalls,
    providerReasoningContent: first.providerReasoningContent, providerReasoningProvenance: first.providerReasoningProvenance });
  messages.push({ role: "tool", toolCallId: first.toolCalls![0].id, toolName: "FileRead", content: "test" });
  const result = await provider.chat(messages, { tools: [], structuredOutput: { schema: { type: "json_schema", name: "answer",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  } } });
  expect(bodyAt(fetchImpl, 0)).not.toHaveProperty("response_format");
  expect(bodyAt(fetchImpl, 1)).not.toHaveProperty("tools");
  expect(bodyAt(fetchImpl, 1)).toHaveProperty("response_format");
  expect(result.structuredOutput?.parsed).toEqual({ ok: true });
});
