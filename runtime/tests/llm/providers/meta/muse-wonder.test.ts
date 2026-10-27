import { describe, expect, test, vi } from "vitest";

import { resolveProviderCapabilityEntry } from "../../../../src/llm/capabilities.js";
import {
  LLMAuthenticationError,
  LLMContextWindowExceededError,
  LLMFundsError,
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
  LLMStreamTruncatedError,
} from "../../../../src/llm/errors.js";
import { createProvider } from "../../../../src/llm/provider.js";
import { MetaProvider } from "../../../../src/llm/providers/meta/index.js";
import { resolveReasoningEffort } from "../../../../src/llm/reasoning-effort.js";
import {
  resolveModelCatalogMetadata,
  resolveRegisteredModelCatalogEntry,
} from "../../../../src/llm/registry/model-catalog.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../../../src/llm/registry/provider-info.js";
import { resolveProviderStructuredOutputMode } from "../../../../src/llm/structured-output.js";
import { getTokenizerConfigForProvider } from "../../../../src/llm/token-estimation.js";
import { buildOpenAIResponsesRequest } from "../../../../src/llm/wire/responses-openai.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMTool,
} from "../../../../src/llm/types.js";
import { DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../../../../src/session/cost.js";
import { StreamModelError } from "../../../../src/phases/stream-model.js";
import { isTransientProviderError } from "../../../../src/recovery/api-errors.js";
import { isRetryableStreamError } from "../../../../src/session/run-turn-stream-retry.js";

// Shapes follow https://dev.meta.ai/docs/protocols/responses and
// https://dev.meta.ai/docs/reasoning. Encrypted content is synthetic.
const MODEL = "muse-wonder-1.0";
const REASONING = {
  type: "reasoning",
  id: "rs_wonder_1",
  summary: [{ type: "summary_text", text: "Read the file first." }],
  encrypted_content: "synthetic-encrypted-reasoning==",
};
const COMMENTARY = {
  id: "msg_wonder_1",
  type: "message",
  role: "assistant",
  status: "completed",
  phase: "commentary",
  content: [{ type: "output_text", text: "Let me read it.", annotations: [] }],
};
const CALL = {
  id: "fc_wonder_1",
  type: "function_call",
  status: "completed",
  call_id: "call_read_1",
  name: "read",
  arguments: '{"path":"a.txt"}',
};
const USAGE = {
  input_tokens: 1_847,
  output_tokens: 98,
  total_tokens: 1_945,
  input_tokens_details: { cached_tokens: 1_792 },
  output_tokens_details: { reasoning_tokens: 61 },
};

const readTool: LLMTool = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completed(output: unknown[], usage: unknown = USAGE): Record<string, unknown> {
  return { id: "resp_wonder", object: "response", status: "completed", model: MODEL, output, usage };
}

function sse(events: ReadonlyArray<Record<string, unknown>>): Response {
  return new Response(
    events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function body(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): Record<string, unknown> {
  return JSON.parse(String(fetchImpl.mock.calls[call]?.[1]?.body)) as Record<string, unknown>;
}

function url(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): string {
  return String(fetchImpl.mock.calls[call]?.[0]);
}

function wonder(fetchImpl: typeof fetch, tools: LLMTool[] = [readTool]): MetaProvider {
  return new MetaProvider({ apiKey: "meta-test", model: MODEL, tools, fetchImpl });
}

/** The assistant turn as the runtime stores it, followed by the tool result. */
function historyAfter(first: Pick<LLMResponse, "content" | "toolCalls" |
  "providerReasoningContent" | "providerReasoningProvenance">): LLMMessage[] {
  return [
    { role: "user", content: "read a.txt" },
    {
      role: "assistant",
      content: first.content,
      toolCalls: first.toolCalls,
      ...(first.providerReasoningContent !== undefined
        ? {
          providerReasoningContent: first.providerReasoningContent,
          providerReasoningProvenance: first.providerReasoningProvenance,
        }
        : {}),
    },
    { role: "tool", toolCallId: "call_read_1", content: "hello" },
  ];
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(() => undefined, (error: unknown) => error);
}

describe("Muse Wonder registration", () => {
  test("registers the Model API id with Meta's documented limits and effort enum", () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.meta).toContain(MODEL);
    expect(resolveRegisteredModelCatalogEntry({ provider: "meta", model: MODEL })).toMatchObject({
      displayName: "Muse Wonder",
      supportedReasoningLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningLevel: "high",
      inputModalities: ["text", "image"],
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
    });
    expect(resolveModelCatalogMetadata({ provider: "meta", model: MODEL })).toEqual({
      contextWindow: 1_048_576,
      maxContextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      maxOutputTokensUpperLimit: 131_072,
    });
    expect(resolveProviderCapabilityEntry({ provider: "meta", model: MODEL })).toMatchObject({
      supportsToolUse: true,
      supportsImageInput: true,
      supportsStructuredOutput: true,
      supportsStructuredOutputWithTools: true,
      acceptsReasoningEffort: true,
    });
    expect(getTokenizerConfigForProvider({ provider: "meta", model: MODEL }).modelFamily).toBe("meta");
  });

  test("prices Muse Wonder at Meta's published standard rate", () => {
    expect(resolveModelCostEntry({ provider: "meta", model: MODEL }, DEFAULT_MODEL_COSTS)?.entry)
      .toMatchObject({ inputUsdPer1K: 0.004, outputUsdPer1K: 0.02, cachedInputUsdPer1K: 0.0002 });
  });

  test("does not register Muse Wonder Full, which Meta sells only inside Muse Code", () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.meta).not.toContain("muse-wonder-full-1.0");
    expect(resolveRegisteredModelCatalogEntry({ provider: "meta", model: "muse-wonder-full-1.0" }))
      .toBeUndefined();
  });

  test("keeps an unregistered Wonder version on the conservative effort enum", () => {
    expect(resolveReasoningEffort({ provider: "meta", model: "muse-wonder-1.1" }).chatLevels)
      .toEqual(new Set(["minimal", "low", "medium", "high", "xhigh"]));
  });

  test("selects structured output by API surface", () => {
    expect(resolveProviderStructuredOutputMode({ provider: "meta", model: MODEL, api: "responses" }))
      .toBe("native_text_format");
    expect(resolveProviderStructuredOutputMode({ provider: "meta", model: MODEL, api: "chat_completions" }))
      .toBe("unsupported");
    expect(resolveProviderStructuredOutputMode({ provider: "meta", model: "muse-spark-1.3", api: "chat_completions" }))
      .toBe("chat_response_format");
    expect(resolveProviderStructuredOutputMode({ provider: "meta", model: "muse-spark-1.3", api: "responses" }))
      .toBe("unsupported");
  });
});

describe("Muse Wonder request shape", () => {
  test("is the Meta default: a provider built without a model sends Wonder to Responses", async () => {
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.meta).toBe(MODEL);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.meta[0]).toBe(MODEL);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(completed([])));
    await createProvider("meta", { apiKey: "meta-test", extra: { fetchImpl } })
      .chat([{ role: "user", content: "hello" }]);

    expect(url(fetchImpl)).toBe(`${BUILT_IN_PROVIDER_BASE_URLS.meta}/responses`);
    expect(body(fetchImpl).model).toBe(MODEL);
  });

  test("factory sends Wonder to Meta's stateless Responses API with bearer auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(completed([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ])));
    const provider = createProvider("meta", { apiKey: "meta-test", model: MODEL, extra: { fetchImpl } });

    const response = await provider.chat([{ role: "user", content: "hello" }], { maxOutputTokens: 32_000 });

    expect(response.content).toBe("ok");
    expect(url(fetchImpl)).toBe(`${BUILT_IN_PROVIDER_BASE_URLS.meta}/responses`);
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Headers).get("authorization")).toBe("Bearer meta-test");
    const request = body(fetchImpl);
    expect(request).toMatchObject({
      model: MODEL,
      stream: false,
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 32_000,
    });
    expect(request.max_completion_tokens).toBeUndefined();
    expect(request.messages).toBeUndefined();
    expect(request.truncation).toBeUndefined();
  });

  test.each(["minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "sends reasoning.effort %s with an automatic summary",
    async (effort) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(completed([])));
      await wonder(fetchImpl).chat([{ role: "user", content: "think" }], { reasoningEffort: effort });

      const request = body(fetchImpl);
      expect(request.reasoning).toEqual({ effort, summary: "auto" });
      expect(request.reasoning_effort).toBeUndefined();
    },
  );

  test("omits effort none, which Meta rejects, and lets the model's default run", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(completed([])));
    await wonder(fetchImpl).chat([{ role: "user", content: "think" }], { reasoningEffort: "none" });

    // The model still reasons at its own level, so its reasoning is kept.
    const request = body(fetchImpl);
    expect(request.reasoning).toEqual({ summary: "auto" });
    expect(request.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("follows an effort change between turns on the same session", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json(completed([])));
    const provider = wonder(fetchImpl);
    await provider.chat([{ role: "user", content: "quick" }], { reasoningEffort: "low" });
    await provider.chat([{ role: "user", content: "deep" }], { reasoningEffort: "max" });

    expect(body(fetchImpl, 0).reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(body(fetchImpl, 1).reasoning).toEqual({ effort: "max", summary: "auto" });
  });

  test("does not grant max to an unregistered Wonder version", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(completed([])));
    const provider = new MetaProvider({ apiKey: "meta-test", model: "muse-wonder-1.1", fetchImpl });
    await provider.chat([{ role: "user", content: "think" }], { reasoningEffort: "max" });

    expect(url(fetchImpl)).toBe(`${BUILT_IN_PROVIDER_BASE_URLS.meta}/responses`);
    expect((body(fetchImpl).reasoning as Record<string, unknown> | undefined)?.effort).toBeUndefined();
  });

  test.each([
    ["auto", "auto"],
    ["required", "auto"],
    [{ name: "read" }, "auto"],
  ] as const)("sends tool choice %j as %s, the only value Meta accepts", async (choice, expected) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(completed([])));
    await wonder(fetchImpl).chat([{ role: "user", content: "go" }], {
      toolChoice: choice as LLMChatOptions["toolChoice"],
    });

    const request = body(fetchImpl);
    expect(request.tool_choice).toBe(expected);
    expect(request.tools).toEqual([expect.objectContaining({ type: "function", name: "read" })]);
  });

  test("sends tool choice none as a request without tools", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(completed([CALL])));
    const response = await wonder(fetchImpl).chat([{ role: "user", content: "summarize" }], { toolChoice: "none" });

    const request = body(fetchImpl);
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    // A call to a tool the request did not advertise keeps its wire name.
    expect(response.toolCalls.map((call) => call.name)).toEqual(["read"]);
  });

  test("sends structured output as text.format on the Responses surface", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(completed([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"ok":true}' }] },
    ])));
    const response = await wonder(fetchImpl, []).chat([{ role: "user", content: "answer" }], {
      structuredOutput: {
        schema: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        },
      },
    });

    expect((body(fetchImpl).text as Record<string, unknown>).format)
      .toMatchObject({ type: "json_schema", name: "answer" });
    expect(response.structuredOutput).toMatchObject({ parsed: { ok: true } });
  });

  test("keeps Muse Spark on Chat Completions when a session switches models", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      String(input).endsWith("/responses")
        ? json(completed([]))
        : json({
          id: "chatcmpl_spark",
          model: "muse-spark-1.3",
          choices: [{ message: { role: "assistant", content: "spark" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }));
    const provider = wonder(fetchImpl);
    await provider.chat([{ role: "user", content: "a" }]);
    await provider.chat([{ role: "user", content: "b" }], { model: "muse-spark-1.3" });

    expect(url(fetchImpl, 0)).toBe(`${BUILT_IN_PROVIDER_BASE_URLS.meta}/responses`);
    expect(url(fetchImpl, 1)).toBe(`${BUILT_IN_PROVIDER_BASE_URLS.meta}/chat/completions`);
  });

  test("advertises the chat safety buffer only for Chat Completions models", async () => {
    const provider = wonder(vi.fn<typeof fetch>());
    expect((await provider.getExecutionProfile()).contextSafetyBufferTokens).toBeUndefined();
    expect((await provider.getExecutionProfile({ model: "muse-spark-1.3" })).contextSafetyBufferTokens)
      .toBeGreaterThan(0);
  });
});

describe("Muse Wonder reasoning and tool calls", () => {
  test("parses a JSON tool turn and replays its reasoning and commentary on the next request", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(completed([REASONING, COMMENTARY, CALL])))
      .mockResolvedValueOnce(json(completed([
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "It says hello." }] },
      ])));
    const provider = wonder(fetchImpl);

    const first = await provider.chat([{ role: "user", content: "read a.txt" }]);
    expect(first.finishReason).toBe("tool_calls");
    expect(first.content).toBe("Let me read it.");
    expect(first.toolCalls).toEqual([{ id: "call_read_1", name: "read", arguments: '{"path":"a.txt"}' }]);
    expect(first.providerReasoningProvenance).toEqual({ provider: "meta", model: MODEL });
    expect(JSON.parse(first.providerReasoningContent ?? "[]")).toEqual([REASONING]);
    expect(first.usage).toMatchObject({
      promptTokens: 1_847,
      completionTokens: 98,
      totalTokens: 1_945,
      cachedInputTokens: 1_792,
      reasoningOutputTokens: 61,
    });

    const second = await provider.chat(historyAfter(first));
    expect(second.content).toBe("It says hello.");
    expect(body(fetchImpl, 1).input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "read a.txt" }] },
      // Meta's Responses guide requires commentary on text before a call.
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Let me read it." }],
      },
      REASONING,
      { type: "function_call", id: "fc_wonder_1", call_id: "call_read_1", name: "read", arguments: '{"path":"a.txt"}' },
      { type: "function_call_output", call_id: "call_read_1", output: "hello" },
    ]);
  });

  test("replays the reasoning of a final answer before that answer, without a phase", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(completed([
        REASONING,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Paris." }] },
      ])))
      .mockResolvedValueOnce(json(completed([])));
    const provider = wonder(fetchImpl, []);

    const first = await provider.chat([{ role: "user", content: "capital of France?" }]);
    await provider.chat([
      { role: "user", content: "capital of France?" },
      {
        role: "assistant",
        content: first.content,
        providerReasoningContent: first.providerReasoningContent,
        providerReasoningProvenance: first.providerReasoningProvenance,
      },
      { role: "user", content: "and Spain?" },
    ]);

    expect(body(fetchImpl, 1).input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "capital of France?" }] },
      REASONING,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Paris." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "and Spain?" }] },
    ]);
  });

  test("does not hand reasoning from another provider or model to Wonder", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(completed([])));
    await wonder(fetchImpl).chat([
      { role: "user", content: "read a.txt" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_read_1", name: "read", arguments: "{}" }],
        providerReasoningContent: JSON.stringify([REASONING]),
        providerReasoningProvenance: { provider: "openai", model: MODEL },
      },
      { role: "tool", toolCallId: "call_read_1", content: "hello" },
    ]);

    expect(body(fetchImpl).input).not.toContainEqual(REASONING);
  });

  test("streams a tool turn, keeps its reasoning and reports usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse([
        { type: "response.created", response: { id: "resp_s1", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...REASONING, encrypted_content: undefined } },
        { type: "response.output_item.done", output_index: 0, item: REASONING },
        { type: "response.output_text.delta", output_index: 1, delta: "Let me " },
        { type: "response.output_text.delta", output_index: 1, delta: "read it." },
        { type: "response.output_item.done", output_index: 1, item: COMMENTARY },
        { type: "response.output_item.added", output_index: 2, item: { ...CALL, status: "in_progress", arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"path":' },
        { type: "response.function_call_arguments.delta", output_index: 2, delta: '"a.txt"}' },
        { type: "response.function_call_arguments.done", output_index: 2, arguments: '{"path":"a.txt"}' },
        { type: "response.output_item.done", output_index: 2, item: CALL },
        { type: "response.completed", response: completed([REASONING, COMMENTARY, CALL]) },
      ]))
      .mockResolvedValueOnce(sse([
        { type: "response.output_text.delta", output_index: 0, delta: "It says hello." },
        { type: "response.completed", response: completed([]) },
      ]));
    const provider = wonder(fetchImpl);
    const chunks: Array<{ content: string; done: boolean; toolCalls?: unknown }> = [];

    const first = await provider.chatStream([{ role: "user", content: "read a.txt" }], (chunk) => {
      chunks.push(chunk);
    }, { reasoningEffort: "xhigh" });

    expect(body(fetchImpl, 0)).toMatchObject({
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "xhigh", summary: "auto" },
    });
    expect(chunks.map((chunk) => chunk.content).join("")).toBe("Let me read it.");
    expect(chunks.some((chunk) => Array.isArray(chunk.toolCalls) &&
      (chunk.toolCalls as Array<{ name: string }>)[0]?.name === "read")).toBe(true);
    expect(first.toolCalls).toEqual([{ id: "call_read_1", name: "read", arguments: '{"path":"a.txt"}' }]);
    expect(first.finishReason).toBe("tool_calls");
    expect(first.providerReasoningProvenance).toEqual({ provider: "meta", model: MODEL });
    expect(first.usage).toMatchObject({ promptTokens: 1_847, cachedInputTokens: 1_792, reasoningOutputTokens: 61 });

    const second = await provider.chatStream(historyAfter(first), () => {}, { reasoningEffort: "medium" });
    expect(second.content).toBe("It says hello.");
    expect(body(fetchImpl, 1).reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(body(fetchImpl, 1).input).toContainEqual(REASONING);
    expect(body(fetchImpl, 1).input).toContainEqual(expect.objectContaining({ phase: "commentary" }));
  });
});

describe("Muse Wonder error mapping", () => {
  const metaError = (type: string, code: string | null, message: string) =>
    ({ error: { message, type, param: null, code } });

  test.each([
    [401, metaError("authentication_error", "invalid_api_key", "Unauthorized"), LLMAuthenticationError],
    [402, metaError("billing_error", "billing_not_configured", "Billing account issue."), LLMFundsError],
    [429, metaError("rate_limit_error", "rate_limit_exceeded", "Rate limit exceeded."), LLMRateLimitError],
    [503, metaError("server_error", "service_overloaded", "The backend is temporarily overloaded."), LLMServerError],
    [400, metaError("invalid_request_error", null,
      "You passed 1200064 input tokens and requested 1 output tokens. However, the model's context length is only 1048576 tokens."),
    LLMContextWindowExceededError],
  ] as const)("maps HTTP %i to its typed error", async (status, errorBody, expected) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json(errorBody, status));
    const error = await failureOf(() =>
      wonder(fetchImpl).chat([{ role: "user", content: "go" }], { singleWireAttempt: true }));
    expect(error).toBeInstanceOf(expected);
  });

  test("keeps a 402 terminal rather than retrying it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      json(metaError("billing_error", "billing_not_configured", "Billing account issue."), 402));
    const error = await failureOf(() =>
      wonder(fetchImpl).chatStream([{ role: "user", content: "go" }], () => {}));
    expect(error).toBeInstanceOf(LLMFundsError);
    expect(isTransientProviderError(error)).toBe(false);
  });

  test("treats a top-level error event before output as a retryable server error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse([
      { type: "response.created", response: { id: "resp_e1", status: "in_progress", output: [] } },
      { type: "error", code: "server_shutting_down", message: "Server is shutting down. Please retry your request." },
    ]));
    const error = await failureOf(() =>
      wonder(fetchImpl).chatStream([{ role: "user", content: "go" }], () => {}));

    expect(error).toBeInstanceOf(LLMServerError);
    expect(error).toMatchObject({ statusCode: 503 });
    expect(String(error)).toMatch(/shutting down/);
    expect(isRetryableStreamError(new StreamModelError(error))).toBe(true);
  });

  test("treats a top-level error event after output as a truncated stream", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse([
      { type: "response.output_text.delta", output_index: 0, delta: "partial" },
      { type: "error", code: "server_shutting_down", message: "Server is shutting down." },
    ]));
    const error = await failureOf(() =>
      wonder(fetchImpl).chatStream([{ role: "user", content: "go" }], () => {}));

    expect(error).toBeInstanceOf(LLMStreamTruncatedError);
  });

  test("maps a transient response.failed to a server error and a policy failure to a terminal one", async () => {
    const failed = (code: string, message: string) => sse([
      { type: "response.failed", response: { id: "resp_f", status: "failed", output: [], error: { code, message } } },
    ]);
    const transient = await failureOf(() => wonder(vi.fn<typeof fetch>().mockResolvedValue(
      failed("server_error", "Internal error."))).chatStream([{ role: "user", content: "go" }], () => {}));
    const policy = await failureOf(() => wonder(vi.fn<typeof fetch>().mockResolvedValue(
      failed("content_policy_violation", "Media rejected."))).chatStream([{ role: "user", content: "go" }], () => {}));

    expect(transient).toBeInstanceOf(LLMServerError);
    expect(policy).toBeInstanceOf(LLMProviderError);
    expect(policy).not.toBeInstanceOf(LLMServerError);
    expect(String(policy)).toMatch(/Media rejected/);
  });
});

describe("shared Responses wire without the Meta contract", () => {
  test("keeps OpenAI tool choice, effort and assistant text unchanged", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-6-sol",
      tools: [readTool],
      options: { toolChoice: "required", reasoningEffort: "none" },
      messages: [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: "Let me read it.", toolCalls: [{ id: "call_read_1", name: "read", arguments: "{}" }] },
        { role: "tool", toolCallId: "call_read_1", content: "hello" },
      ],
    });

    expect(request.tool_choice).toBe("required");
    expect(request.reasoning).toEqual({ effort: "none" });
    expect(request.input).toContainEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Let me read it." }],
    });
  });
});
