import { describe, expect, test, vi } from "vitest";
import { OpenRouterProvider } from "../../../../src/llm/providers/openrouter/index.js";
import { ModelMetadataResolver } from "../../../../src/llm/model-metadata.js";
import type { AgenCConfig } from "../../../../src/config/schema.js";
import type { LLMMessage, LLMResponse, LLMTool } from "../../../../src/llm/types.js";
import { isLLMPreGenerationRejection } from "../../../../src/llm/errors.js";
import { fitOutputReservationToContext } from "../../../../src/budget/admitted-model-call.js";

const tools: LLMTool[] = [{ type: "function", function: {
  name: "FileRead", description: "Read a file",
  parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
} }];
const call = { id: "read-1", type: "function", function: { name: "FileRead", arguments: '{"file_path":"hello.txt"}' } };
const user: LLMMessage = { role: "user", content: "Read hello.txt" };

function response(model: string, streaming: boolean, reasoning: Record<string, unknown>): Response {
  const message = { role: "assistant", content: "", ...reasoning, tool_calls: [call] };
  if (!streaming) return new Response(JSON.stringify({ model, choices: [{ message, finish_reason: "tool_calls" }] }), { headers: { "content-type": "application/json" } });
  return new Response([
    { model, choices: [{ index: 0, delta: { ...message, tool_calls: [{ index: 0, ...call }] } }] },
    { model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
}

function continuation(reply: LLMResponse): LLMMessage[] {
  return [user, { role: "assistant", content: reply.content, toolCalls: reply.toolCalls,
    providerReasoningContent: reply.providerReasoningContent,
    providerReasoningProvenance: reply.providerReasoningProvenance },
  { role: "tool", toolCallId: reply.toolCalls[0]!.id, content: "hi" }];
}

describe("OpenRouter model compatibility", () => {
  test("cancels a reasoning-only stream at the caller's deadline without another request", async () => {
    const abort = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const signal = init!.signal!;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning":"Still thinking"}}]}\n\n'));
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          // A stream can keep producing reasoning without an answer or call.
          // The caller's deadline must still interrupt it.
          setTimeout(() => abort.abort(new Error("test deadline reached")), 10);
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const provider = new OpenRouterProvider({ apiKey: "test", model: "vendor/reasoner", tools, fetchImpl });
    await expect(provider.chatStream([user], () => {}, { signal: abort.signal, singleWireAttempt: true }))
      .rejects.toThrow(/deadline|abort/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])("rejects a native call with no name instead of guessing an executable tool (stream=%s)", async streaming => {
    const broken = { id: "broken", type: "function", function: { arguments: '{"file_path":"hello.txt"}' } };
    const body = streaming
      ? `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...broken }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ choices: [{ message: { content: "", tool_calls: [broken] }, finish_reason: "tool_calls" }] });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      headers: { "content-type": streaming ? "text/event-stream" : "application/json" },
    }));
    const provider = new OpenRouterProvider({ apiKey: "test", model: "deepseek/deepseek-r1-0528", tools, fetchImpl });
    const reply = streaming
      ? provider.chatStream([user], () => {}, { singleWireAttempt: true })
      : provider.chat([user], { singleWireAttempt: true });
    await expect(reply).rejects.toThrow(/missing a non-empty name/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("shares a proportional small-window buffer between admission and the actual request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } }));
    const provider = new OpenRouterProvider({ apiKey: "test", model: "vendor/small-context", tools, fetchImpl });
    const options = { contextWindowTokens: 3_890, maxOutputTokens: 2_047, accountedInputTokens: 2_200 };
    const profile = await provider.getExecutionProfile(options);
    expect(profile.contextSafetyBufferTokens).toBe(194);
    // The old fixed 1024-token buffer left only 666 output tokens, below
    // admission's minimum, so an otherwise valid request never reached HTTP.
    const fitted = fitOutputReservationToContext({ admissible: true, inputTokens: 2_200, totalTokens: 4_247 }, 3_890, 2_047, profile.contextSafetyBufferTokens);
    expect(fitted).toBe(1_496);
    await provider.chat([user], { ...options, maxOutputTokens: fitted });
    const wire = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(wire.max_tokens).toBe(1_496);
    expect((await provider.getExecutionProfile({ contextWindowTokens: 128_000 })).contextSafetyBufferTokens).toBe(1_024);
  });

  test.each([false, true])("does not send unsupported GPT parallel control under strict routing (stream=%s)", async streaming => {
    const model = "openai/gpt-6-luna";
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response(model, streaming, {}));
    const provider = new OpenRouterProvider({ apiKey: "test", model, tools, fetchImpl });
    const options = { parallelToolCalls: true, promptCacheKey: "session" };
    if (streaming) await provider.chatStream([user], () => {}, options);
    else await provider.chat([user], options);
    const wire = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(wire).not.toHaveProperty("parallel_tool_calls");
    expect(wire.prompt_cache_key).toBe("session");
    expect(wire.provider.require_parameters).toBe(true);
  });

  test("reports an incompatible route as a pre-generation refusal without retrying or dropping tools", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ error: {
      message: "No endpoints found that can handle the requested parameters.", code: 404,
    } }), { status: 404, headers: { "content-type": "application/json" } }));
    const provider = new OpenRouterProvider({ apiKey: "test", model: "vendor/model", tools, fetchImpl, zeroDataRetention: true });
    const error = await provider.chatStream([user], () => {}, { singleWireAttempt: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("no endpoint that supports the requested parameters");
    expect((error as Error).message).not.toContain("OPENAI_BASE_URL");
    expect(isLLMPreGenerationRejection(error, "openrouter")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])("replays reasoning for arbitrary routed families (stream=%s)", async streaming => {
    // Beam, MiniMax and future catalog families use the same gateway contract.
    for (const model of ["reflection/beam-1.0-501b-a23b", "minimax/minimax-m1", "vendor/future-model"]) {
      for (const field of ["reasoning", "reasoning_content"]) {
        const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response(model, streaming, { [field]: "Read before answering." }));
        const provider = new OpenRouterProvider({ apiKey: "test", model, tools, fetchImpl });
        const invoke = (messages: LLMMessage[]) => streaming
          ? provider.chatStream(messages, () => {}) : provider.chat(messages);
        const reply = await invoke([user]);
        expect(reply.content).toBe("");
        expect(reply.providerReasoningContent).toBe("Read before answering.");
        await invoke(continuation(reply));
        const wire = JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body));
        expect(wire.messages[1]).toMatchObject({ role: "assistant", reasoning: "Read before answering.", tool_calls: [call] });
        expect(wire.provider).toEqual({ require_parameters: true });
      }
    }
  });

  test.each([false, true])("preserves structured reasoning over summary text (stream=%s)", async streaming => {
    const model = "vendor/reasoner";
    const details = [{ type: "reasoning.encrypted", data: "opaque-state", id: "reason-1", format: "provider-v1", index: 0 }];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response(model, streaming, {
      reasoning: "Display summary", reasoning_details: details,
    }));
    const provider = new OpenRouterProvider({ apiKey: "test", model, tools, fetchImpl, zeroDataRetention: true });
    const invoke = (messages: LLMMessage[]) => streaming
      ? provider.chatStream(messages, () => {}) : provider.chat(messages);
    const reply = await invoke([user]);
    expect(reply.content).toBe("");
    await invoke(continuation(reply));
    const wire = JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body));
    expect(wire.messages[1].reasoning_details).toEqual(details);
    expect(wire.messages[1]).not.toHaveProperty("reasoning");
    expect(wire.provider).toEqual({ require_parameters: true, zdr: true });

    const messages = continuation(reply);
    messages[1] = { ...messages[1]!, providerReasoningProvenance: { provider: "openrouter", model: "another/model" } };
    await invoke(messages);
    const changed = JSON.parse(String(fetchImpl.mock.calls[2]![1]!.body));
    expect(changed.messages[1]).not.toHaveProperty("reasoning_details");
    expect(changed.messages[1]).not.toHaveProperty("reasoning");
  });

  test.each([false, true])("keeps reasoning-only replies hidden instead of claiming an answer (stream=%s)", async streaming => {
    const model = "minimax/minimax-m1";
    const message = { content: "", reasoning: 'The file says hi.\nhi', reasoning_details: [{ type: "reasoning.text", text: 'The file says hi.\nhi', index: 0 }] };
    const body = streaming
      ? `data: ${JSON.stringify({ model, choices: [{ delta: message, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ model, choices: [{ message, finish_reason: "stop" }] });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      headers: { "content-type": streaming ? "text/event-stream" : "application/json" },
    }));
    const provider = new OpenRouterProvider({ apiKey: "test", model, tools, fetchImpl });
    const reply = streaming ? await provider.chatStream([user], () => {}) : await provider.chat([user]);
    expect(reply.content).toBe("");
    expect(reply.toolCalls).toEqual([]);
    expect(reply.providerReasoningContent).toContain("reasoning_details");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])("keeps tool-shaped answer text separate from native calls (stream=%s)", async streaming => {
    const model = "google/gemma-3-12b-it";
    const content = '```tool_code\n[FileRead(file_path="hello.txt")]\n```';
    const body = streaming
      ? `data: ${JSON.stringify({ model, choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ model, choices: [{ message: { content }, finish_reason: "stop" }] });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      headers: { "content-type": streaming ? "text/event-stream" : "application/json" },
    }));
    const provider = new OpenRouterProvider({ apiKey: "test", model, tools, fetchImpl });
    const reply = streaming ? await provider.chatStream([user], () => {}) : await provider.chat([user]);
    expect(reply.content).toBe(content);
    expect(reply.toolCalls).toEqual([]);
  });

  test("uses a bounded default without lowering the documented or explicit output limit", async () => {
    const resolver = new ModelMetadataResolver({ env: {} });
    const lookup = { provider: "openrouter", model: "xiaomi/mimo-v2.5-pro", config: {} as AgenCConfig };
    const defaults = resolver.resolveSync(lookup);
    expect(defaults.maxOutputTokens).toBe(32_000);
    expect(defaults.maxOutputTokensUpperLimit).toBeGreaterThan(32_000);
    expect(defaults.maxOutputTokensCappedDefault).toBe(true);
    // The catalog's top endpoint has a 1,050,000-token context, while the
    // observed ZDR endpoint rejected the old reservation at 262,144 tokens.
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return request.max_tokens + 1_680 > 262_144
        ? new Response(JSON.stringify({ error: { message: "maximum context length is 262144 tokens", code: 400 } }),
          { status: 400, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
          { headers: { "content-type": "application/json" } });
    });
    const reply = await new OpenRouterProvider({ apiKey: "test", model: lookup.model,
      maxTokens: defaults.maxOutputTokens, tools, fetchImpl, zeroDataRetention: true }).chat([user]);
    expect(reply.content).toBe("hi");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const explicit = resolver.resolveSync({ ...lookup, config: { providers: { openrouter: { max_output_tokens: 65_536 } } } as AgenCConfig });
    expect(explicit.maxOutputTokens).toBe(65_536);
    expect(explicit.maxOutputTokensExplicit).toBe(true);
    const small = resolver.resolveSync({ ...lookup, model: "openai/gpt-3.5-turbo-0613" });
    expect(small.maxOutputTokens).toBeLessThan(4_095);
  });
});
