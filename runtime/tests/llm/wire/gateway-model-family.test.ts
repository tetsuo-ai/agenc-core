/**
 * The same model through OpenRouter, Ollama Cloud or Venice gets the request
 * shape its own API gets where the gateway documents the equivalent field:
 * reasoning read and replayed (OpenRouter `reasoning`, structured
 * `reasoning_details` for GPT), the DeepSeek shared-prefix layout, no
 * parallel_tool_calls for DeepSeek, a session cache key, and the gateway's own
 * per-call charge.
 */
import { describe, expect, test, vi } from "vitest";

import {
  buildChatCompletionsRequest,
  parseChatCompletionsResponse,
} from "../../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER } from "../../../src/llm/wire/shared.js";
import {
  ReasoningDetailsAccumulator,
  decodeReasoningDetailsReplay,
  encodeReasoningDetailsReplay,
} from "../../../src/llm/wire/reasoning-details.js";
import { OpenRouterProvider } from "../../../src/llm/providers/openrouter/index.js";
import { VeniceProvider } from "../../../src/llm/providers/venice/index.js";
import type { LLMMessage, LLMTool } from "../../../src/llm/types.js";
import { bodyAt, sseResponse } from "../providers/openai-compatible-test-helpers.js";

const TOOLS: LLMTool[] = [{
  type: "function",
  function: { name: "FileRead", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } },
}];
const ENCRYPTED = { type: "reasoning.encrypted", data: "gAAAA-opaque", format: "openai-responses-v1", id: "rs_1", index: 1 };
const SUMMARY = { type: "reasoning.summary", summary: "**Plan** read the file", format: "openai-responses-v1", index: 0 };

describe("gateway hints follow the model family", () => {
  test("OpenRouter DeepSeek: reasoning read and replayed, shared prefix, no parallel_tool_calls, prefix cache key", () => {
    const hints = chatCompletionsCapabilityHintsForProvider("openrouter", "deepseek/deepseek-v4.1-flash-1017");
    expect(hints).toMatchObject({
      reasoningContentField: "reasoning", reasoningContentFallbackField: "reasoning_content",
      replaysReasoningContent: true, acceptsParallelToolCalls: false, sharesPromptPrefixAcrossSessions: true,
      promptCacheKeyFields: ["prompt_cache_key"], promptCacheKeyScope: "prefix",
      reasoningEffortEnvelope: "openrouter", reportsUsageCost: true,
    });
    expect(hints.replaysReasoningDetails).toBe(true);
  });

  test("OpenRouter GPT: reasoning_details replayed, the session's prompt_cache_key", () => {
    const hints = chatCompletionsCapabilityHintsForProvider("openrouter", "openai/gpt-6-luna");
    expect(hints).toMatchObject({
      reasoningContentField: "reasoning", replaysReasoningContent: true, replaysReasoningDetails: true,
      promptCacheKeyFields: ["prompt_cache_key"],
    });
    expect(hints.promptCacheKeyScope).toBeUndefined();
    expect(hints.acceptsParallelToolCalls).toBe(false);
    expect(hints.sharesPromptPrefixAcrossSessions).toBeUndefined();
  });

  test("OpenRouter models of other families also replay gateway reasoning", () => {
    const hints = chatCompletionsCapabilityHintsForProvider("openrouter", "z-ai/glm-5.3");
    expect(hints.replaysReasoningContent).toBe(true);
    expect(hints.replaysReasoningDetails).toBe(true);
    expect(hints.reasoningContentField).toBe("reasoning");
    expect(hints.promptCacheKeyFields).toBeUndefined();
  });

  test("OpenRouter never gets session_id: it would pin a session to the first host it reaches", () => {
    // With session_id OpenRouter keeps a session on the host of its first
    // request; with prompt_cache_key only after that host returned a cache hit.
    for (const model of ["deepseek/deepseek-v4.1-flash-1017", "deepseek/deepseek-v4-pro-0813", "openai/gpt-6-luna", "z-ai/glm-5.3"]) {
      expect(chatCompletionsCapabilityHintsForProvider("openrouter", model).promptCacheKeyFields ?? []).not.toContain("session_id");
    }
  });

  test("the managed AgenC route keeps its reviewed contract", () => {
    const hints = chatCompletionsCapabilityHintsForProvider("openrouter", "deepseek/deepseek-v4.1-flash", { managedGateway: true });
    expect(hints.promptCacheKeyFields).toBeUndefined();
    expect(hints.sharesPromptPrefixAcrossSessions).toBeUndefined();
    expect(hints.reportsUsageCost).toBeUndefined();
  });

  test("Venice: prompt_cache_key and top-level cost for every model; family layout and replay", () => {
    const deepseek = chatCompletionsCapabilityHintsForProvider("venice", "deepseek-v4-1-flash-1017");
    expect(deepseek).toMatchObject({ promptCacheKeyFields: ["prompt_cache_key"], promptCacheKeyScope: "prefix",
      reportsTopLevelCost: true, sharesPromptPrefixAcrossSessions: true, replaysReasoningContent: true,
      reasoningContentField: "reasoning_content" });
    expect(deepseek.replaysReasoningDetails).toBeUndefined();
    const gpt = chatCompletionsCapabilityHintsForProvider("venice", "openai-gpt-6-luna");
    expect(gpt).toMatchObject({ replaysReasoningDetails: true, reportsTopLevelCost: true });
    expect(gpt.sharesPromptPrefixAcrossSessions).toBeUndefined();
  });

  test("Ollama Cloud: DeepSeek gets DeepSeek's prompt, other models keep the alias block", () => {
    const deepseek = chatCompletionsCapabilityHintsForProvider("ollama-cloud", "deepseek-v4.1-flash:1017");
    expect(deepseek.sharesPromptPrefixAcrossSessions).toBe(true);
    expect(deepseek.includeToolNameAliases).toBeUndefined();
    const glm = chatCompletionsCapabilityHintsForProvider("ollama-cloud", "glm-5.3");
    expect(glm.includeToolNameAliases).toBe(true);
    expect(glm.sharesPromptPrefixAcrossSessions).toBeUndefined();
  });
});

describe("DeepSeek's default effort through gateways", () => {
  test.each([
    // Ollama Cloud sends none for Off, so an unset effort is not an opt-out
    // even where the route lists none.
    ["ollama-cloud", "deepseek-v4-pro:0813", { reasoning_effort: "high" }],
    ["ollama-cloud", "deepseek-v4.1-flash", { reasoning_effort: "high" }],
  ] as const)("%s %s gets high when the session sets no effort", (provider, model, expected) => {
    const hints = chatCompletionsCapabilityHintsForProvider(provider, model);
    expect(hints.defaultReasoningEffort).toBe("high");
    const body = buildChatCompletionsRequest({ model, messages: [{ role: "user", content: "x" }], tools: TOOLS,
      providerCapabilityHints: hints });
    expect(body).toMatchObject(expected);
    const chosen = buildChatCompletionsRequest({ model, messages: [{ role: "user", content: "x" }], tools: TOOLS,
      providerCapabilityHints: hints, options: { reasoningEffort: "low" } });
    expect(JSON.stringify(chosen)).toContain('"low"');
    const recovery = buildChatCompletionsRequest({ model, messages: [{ role: "user", content: "x" }], tools: TOOLS,
      providerCapabilityHints: hints, options: { disableThinkingForRecovery: true } });
    expect(recovery.reasoning_effort ?? recovery.reasoning).toBeUndefined();
  });

  test("a route that offers none leaves an unset effort off the wire (it may be a deliberate opt-out)", () => {
    const hints = chatCompletionsCapabilityHintsForProvider("openrouter", "deepseek/deepseek-v4.1-flash-1017");
    expect(hints.defaultReasoningEffort).toBeUndefined();
    // OpenRouter's live list offers none on every DeepSeek route (2026-10-20).
    expect(chatCompletionsCapabilityHintsForProvider("openrouter", "deepseek/deepseek-v4-pro-0813").defaultReasoningEffort)
      .toBeUndefined();
    expect(chatCompletionsCapabilityHintsForProvider("ollama-cloud", "glm-5.3").defaultReasoningEffort).toBeUndefined();
    expect(chatCompletionsCapabilityHintsForProvider("deepseek", "deepseek-flash").defaultReasoningEffort).toBeUndefined();
  });
});

describe("gateway request shape", () => {
  const head = "STATIC_HEAD";
  const systemPrompt = `${head}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}\n\nSESSION_TAIL`;

  test("OpenRouter DeepSeek sends the prefix cache key, no parallel_tool_calls, DeepSeek's layout and the replayed reasoning", () => {
    const model = "deepseek/deepseek-v4.1-flash-1017";
    const hints = chatCompletionsCapabilityHintsForProvider("openrouter", model);
    const history: LLMMessage[] = [
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "FileRead", arguments: "{\"path\":\"a.txt\"}" }],
        providerReasoningContent: "need the file", providerReasoningProvenance: { provider: "openrouter", model } },
      { role: "tool", toolCallId: "c1", toolName: "FileRead", content: "hello" },
    ];
    const body = buildChatCompletionsRequest({
      model, messages: history, tools: TOOLS, providerCapabilityHints: hints,
      options: { systemPrompt, promptCacheKey: "conv-abc", parallelToolCalls: false, reasoningEffort: "high" },
    });
    // DeepSeek's own API shares one prefix cache across sessions; the key
    // groups sessions by model and leading system message, not by session.
    expect(body.prompt_cache_key).toMatch(/^agenc-[0-9a-f]{40}$/u);
    const otherSession = buildChatCompletionsRequest({
      model, messages: [{ role: "user", content: "another task" }], tools: TOOLS, providerCapabilityHints: hints,
      options: { systemPrompt, promptCacheKey: "conv-other" },
    });
    expect(otherSession.prompt_cache_key).toBe(body.prompt_cache_key);
    const otherHead = buildChatCompletionsRequest({
      model, messages: [{ role: "user", content: "another task" }], tools: TOOLS, providerCapabilityHints: hints,
      options: { systemPrompt: `OTHER_HEAD\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}\n\nSESSION_TAIL`, promptCacheKey: "conv-abc" },
    });
    expect(otherHead.prompt_cache_key).not.toBe(body.prompt_cache_key);
    expect(JSON.stringify(body)).not.toContain("conv-abc");
    expect(body.session_id).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: "high" });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: head });
    expect(messages[1]).toEqual({ role: "user", content: "<system-reminder>\nSESSION_TAIL\n</system-reminder>" });
    expect(messages.find(m => m.role === "assistant")).toMatchObject({ reasoning: "need the file" });
  });

  test("a reply's reasoning_details come back unchanged on the next OpenRouter GPT request", () => {
    const model = "openai/gpt-6-luna";
    const hints = chatCompletionsCapabilityHintsForProvider("openrouter", model);
    const request = { model, messages: [{ role: "user", content: "read a.txt" }] as LLMMessage[], tools: TOOLS,
      providerCapabilityHints: hints };
    const reply = parseChatCompletionsResponse(model, {
      model,
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
        reasoning: "**Plan** read the file", reasoning_details: [SUMMARY, ENCRYPTED],
        tool_calls: [{ id: "c1", type: "function", function: { name: "FileRead", arguments: "{\"path\":\"a.txt\"}" } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00001 },
    }, request);
    expect(reply.thinking?.[0]?.text).toBe("**Plan** read the file");
    expect(decodeReasoningDetailsReplay(reply.providerReasoningContent)).toEqual([SUMMARY, ENCRYPTED]);
    expect(reply.usage.providerCostUsd).toBe(0.00001);
    const body = buildChatCompletionsRequest({
      ...request,
      messages: [
        ...request.messages,
        { role: "assistant", content: "", toolCalls: reply.toolCalls, providerReasoningContent: reply.providerReasoningContent,
          providerReasoningProvenance: reply.providerReasoningProvenance },
        { role: "tool", toolCallId: "c1", toolName: "FileRead", content: "hello" },
      ],
      options: { promptCacheKey: "conv-abc", parallelToolCalls: true },
    });
    const assistant = (body.messages as Array<Record<string, unknown>>).find(m => m.role === "assistant")!;
    expect(assistant.reasoning_details).toEqual([SUMMARY, ENCRYPTED]);
    expect(assistant.reasoning).toBeUndefined();
    expect(body.session_id).toBeUndefined();
    expect(body.prompt_cache_key).toBe("conv-abc");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  describe("OpenRouter prompt caching for models that cache only on request", () => {
    const conversation: LLMMessage[] = [
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "FileRead", arguments: "{\"path\":\"a.txt\"}" }] },
      { role: "tool", toolCallId: "c1", toolName: "FileRead", content: "hello" },
    ];
    const build = (model: string) => buildChatCompletionsRequest({
      model, messages: conversation, tools: TOOLS,
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("openrouter", model),
      options: { systemPrompt: "SYSTEM_HEAD" },
    });

    test("Claude gets one top-level marker that follows the conversation", () => {
      const body = build("anthropic/claude-sonnet-5.5");
      expect(body.cache_control).toEqual({ type: "ephemeral" });
      expect(JSON.stringify(body.messages)).not.toContain("cache_control");
    });

    test("Gemini gets one marker, on the system prompt", () => {
      const body = build("google/gemini-3.8-flash");
      expect(body.cache_control).toBeUndefined();
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages[0]).toEqual({ role: "system",
        content: [{ type: "text", text: "SYSTEM_HEAD", cache_control: { type: "ephemeral" } }] });
      expect(JSON.stringify(messages.slice(1))).not.toContain("cache_control");
    });

    test("models that cache on their own get no marker", () => {
      for (const model of ["qwen/qwen3-coder-next", "z-ai/glm-5.3", "openai/gpt-6-luna", "deepseek/deepseek-v4-flash"]) {
        expect(JSON.stringify(build(model))).not.toContain("cache_control");
      }
    });
  });

  test("reasoning items from another model are not replayed", () => {
    const hints = chatCompletionsCapabilityHintsForProvider("openrouter", "openai/gpt-6-luna");
    const body = buildChatCompletionsRequest({
      model: "openai/gpt-6-luna", tools: TOOLS, providerCapabilityHints: hints,
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "FileRead", arguments: "{}" }],
          providerReasoningContent: encodeReasoningDetailsReplay([ENCRYPTED]),
          providerReasoningProvenance: { provider: "openrouter", model: "openai/gpt-6-sol" } },
        { role: "tool", toolCallId: "c1", toolName: "FileRead", content: "y" },
      ],
    });
    const assistant = (body.messages as Array<Record<string, unknown>>).find(m => m.role === "assistant")!;
    expect(assistant.reasoning_details).toBeUndefined();
    expect(assistant.reasoning).toBeUndefined();
  });

  test("Venice reports its own charge and gets the session's prompt_cache_key", () => {
    const model = "deepseek-v4-1-flash-1017";
    const hints = chatCompletionsCapabilityHintsForProvider("venice", model);
    const body = buildChatCompletionsRequest({ model, messages: [{ role: "user", content: "x" }], tools: TOOLS,
      providerCapabilityHints: hints, options: { promptCacheKey: "conv-abc", systemPrompt: "HEAD" } });
    expect(body.prompt_cache_key).toMatch(/^agenc-[0-9a-f]{40}$/u);
    expect(body.session_id).toBeUndefined();
    // Without a system message there is no shared prefix to name: the session key stands in.
    const bare = buildChatCompletionsRequest({ model, messages: [{ role: "user", content: "x" }], tools: TOOLS,
      providerCapabilityHints: hints, options: { promptCacheKey: "conv-abc" } });
    expect(bare.prompt_cache_key).toBe("conv-abc");
    const reply = parseChatCompletionsResponse(model, {
      model, cost: { usd: 0.000288, diem: 0 },
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok", reasoning_content: "think" } }],
      usage: { prompt_tokens: 372, completion_tokens: 147, total_tokens: 519, prompt_tokens_details: { cached_tokens: 0 } },
    }, { model, messages: [], tools: [], providerCapabilityHints: hints });
    expect(reply.usage.providerCostUsd).toBeCloseTo(0.000288, 9);
    expect(reply.providerReasoningContent).toBe("think");
  });

  test.each([
    "x-ai/grok-build-0.1",
    "qwen/qwen3-coder",
    "anthropic/claude-sonnet-5.5",
    "google/gemini-3.8-flash",
    "z-ai/glm-5.3",
  ])("OpenRouter %s gets no parallel_tool_calls: the upstream default allows parallel calls", (model) => {
    // Core asks for serial calls whenever OpenRouter's parameter list omits the
    // field; sending that false made these models read files one at a time.
    for (const parallelToolCalls of [false, true]) {
      const body = buildChatCompletionsRequest({
        model, messages: [{ role: "user", content: "read a.txt and b.txt" }], tools: TOOLS,
        providerCapabilityHints: chatCompletionsCapabilityHintsForProvider("openrouter", model),
        options: { parallelToolCalls },
      });
      expect(body.parallel_tool_calls).toBeUndefined();
    }
  });
});

describe("streamed reasoning_details", () => {
  test("fragments with one index merge into one item; whole items stay whole", () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.push([{ type: "reasoning.summary", summary: "**Plan**", format: "openai-responses-v1", index: 0 }]);
    acc.push([{ type: "reasoning.summary", summary: " read the file", format: "openai-responses-v1", index: 0 }]);
    acc.push([ENCRYPTED]);
    acc.push("not an array");
    acc.push([{ no: "type" }]);
    expect(acc.items()).toEqual([SUMMARY, ENCRYPTED]);
  });

  test("an OpenRouter GPT stream keeps the summary as thinking and replays the items on the next call", async () => {
    const model = "openai/gpt-6-luna";
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sseResponse([
        frame({ id: "g1", model, provider: "OpenAI", choices: [{ index: 0, delta: { role: "assistant", reasoning: "**Plan**",
          reasoning_details: [{ type: "reasoning.summary", summary: "**Plan**", format: "openai-responses-v1", index: 0 }] } }] }),
        frame({ id: "g1", model, provider: "OpenAI", choices: [{ index: 0, delta: { reasoning: " read the file",
          reasoning_details: [{ type: "reasoning.summary", summary: " read the file", format: "openai-responses-v1", index: 0 }] } }] }),
        frame({ id: "g1", model, provider: "OpenAI", choices: [{ index: 0, delta: { reasoning_details: [ENCRYPTED] } }] }),
        frame({ id: "g1", model, provider: "OpenAI", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function",
          function: { name: "FileRead", arguments: "{\"path\":\"a.txt\"}" } }] } }] }),
        frame({ id: "g1", model, provider: "OpenAI", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00002 } }),
        "data: [DONE]\n\n",
      ]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "g2", model,
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
        usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21, cost: 0.00001 } }),
      { headers: { "content-type": "application/json" } }));
    const provider = new OpenRouterProvider({ apiKey: "or-test", model, fetchImpl });
    const first = await provider.chatStream([{ role: "user", content: "read a.txt" }], () => {},
      { tools: TOOLS, promptCacheKey: "conv-abc", reasoningEffort: "high" });
    expect(first.thinking?.[0]?.text).toBe("**Plan** read the file");
    expect(decodeReasoningDetailsReplay(first.providerReasoningContent)).toEqual([SUMMARY, ENCRYPTED]);
    expect(first.usage.providerCostUsd).toBe(0.00002);
    expect(bodyAt(fetchImpl, 0)).toMatchObject({ prompt_cache_key: "conv-abc", reasoning: { effort: "high" } });
    expect(bodyAt(fetchImpl, 0).session_id).toBeUndefined();
    await provider.chat([
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "", toolCalls: first.toolCalls, providerReasoningContent: first.providerReasoningContent,
        providerReasoningProvenance: first.providerReasoningProvenance },
      { role: "tool", toolCallId: first.toolCalls[0]!.id, toolName: "FileRead", content: "hello" },
    ], { tools: TOOLS, promptCacheKey: "conv-abc" });
    const assistant = (bodyAt(fetchImpl, 1).messages as Array<Record<string, unknown>>).find(m => m.role === "assistant")!;
    expect(assistant.reasoning_details).toEqual([SUMMARY, ENCRYPTED]);
  });
});

describe("Venice GPT stream", () => {
  test("the summary stays thinking, the encrypted items replay, and Venice's own charge is the call's cost", async () => {
    const model = "openai-gpt-6-luna";
    const models = { data: [{ id: model, type: "text", model_spec: { name: "GPT-6 Luna", availableContextTokens: 1_050_000,
      maxCompletionTokens: 128_000, offline: false, privacy: "anonymized", traits: [],
      capabilities: { supportsFunctionCalling: true, supportsReasoning: true, supportsReasoningEffort: true,
        reasoningEffortOptions: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high", supportsVision: true },
      pricing: { input: { usd: 0.1 }, cache_input: { usd: 0.01 }, output: { usd: 0.5 } } } }] };
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const venicEncrypted = { type: "reasoning.encrypted", format: "openai-responses-v1", index: "0", id: "rs_v", data: "gAAAA-venice" };
    const chats: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/models") || url.includes("/models?")) return Response.json(models);
      chats.push(JSON.parse(String(init?.body)));
      if (chats.length === 1) {
        return sseResponse([
          frame({ id: "v1", model, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "**Plan** read" } }] }),
          frame({ id: "v1", model, choices: [{ index: 0, delta: { reasoning_details: [venicEncrypted], reasoning_encrypted: true } }] }),
          frame({ id: "v1", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function",
            function: { name: "FileRead", arguments: "{\"path\":\"a.txt\"}" } }] } }] }),
          frame({ id: "v1", model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
          frame({ id: "v1", model, choices: [], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160,
            prompt_tokens_details: { cached_tokens: 0 } }, cost: { usd: 0.0000653, diem: 0 } }),
          "data: [DONE]\n\n",
        ]);
      }
      return Response.json({ id: "v2", model, cost: { usd: 0.00002, diem: 0 },
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
        usage: { prompt_tokens: 200, completion_tokens: 2, total_tokens: 202 } });
    });
    const provider = new VeniceProvider({ apiKey: "venice-test", model, fetchImpl });
    const first = await provider.chatStream([{ role: "user", content: "read a.txt" }], () => {},
      { tools: TOOLS, promptCacheKey: "conv-v", reasoningEffort: "high" });
    expect(first.thinking?.[0]?.text).toBe("**Plan** read");
    expect(decodeReasoningDetailsReplay(first.providerReasoningContent)).toEqual([venicEncrypted]);
    expect(first.usage.providerCostUsd).toBeCloseTo(0.0000653, 10);
    expect(chats[0]).toMatchObject({ prompt_cache_key: "conv-v", reasoning_effort: "high" });
    const second = await provider.chat([
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "", toolCalls: first.toolCalls, providerReasoningContent: first.providerReasoningContent,
        providerReasoningProvenance: first.providerReasoningProvenance },
      { role: "tool", toolCallId: first.toolCalls[0]!.id, toolName: "FileRead", content: "hello" },
    ], { tools: TOOLS, promptCacheKey: "conv-v" });
    expect(second.usage.providerCostUsd).toBeCloseTo(0.00002, 10);
    const assistant = (chats[1]!.messages as Array<Record<string, unknown>>).find(m => m.role === "assistant")!;
    expect(assistant.reasoning_details).toEqual([venicEncrypted]);
    expect(assistant.reasoning_content).toBeUndefined();
  });
});
