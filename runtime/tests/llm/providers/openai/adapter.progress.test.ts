import { afterEach, describe, expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../../../src/llm/providers/deepseek/index.js";
import { KimiProvider } from "../../../../src/llm/providers/kimi/index.js";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import type { LLMStreamChunk, LLMTool } from "../../../../src/llm/types.js";
import { REASONING_NO_PROGRESS_MS } from "../../../../src/llm/stream-progress.js";
import { streamModel } from "../../../../src/phases/stream-model.js";
import { buildInitialTurnState } from "../../../../src/session/turn-state.js";
import { SessionProviderService } from "../../../../src/session/provider-service.js";
import { mkCtx, mkSession } from "../../../fixtures.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const readTool: LLMTool = {
  type: "function",
  function: {
    name: "FileRead", description: "Read a file",
    parameters: {
      type: "object", properties: { file_path: { type: "string" } },
      required: ["file_path"], additionalProperties: false,
    },
  },
};

function probe(name: "deepseek" | "kimi", deltas: Record<string, unknown>[]) {
  const chunks: LLMStreamChunk[] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (choice: Record<string, unknown>) => controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, ...choice }] })}\n\n`),
        );
        emit({ delta: { reasoning_content: "Prepare the file read." } });
        let index = 0;
        const onAbort = () => {
          clearInterval(timer);
          controller.error(signal?.reason);
        };
        const timer = setInterval(() => {
          emit({ delta: deltas[index++] });
          if (index === deltas.length) {
            clearInterval(timer);
            signal?.removeEventListener("abort", onAbort);
            emit({ delta: {}, finish_reason: "tool_calls" });
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          }
        }, 60_000);
        signal?.addEventListener("abort", onAbort, { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } });
  });
  const config = { apiKey: "dummy-test", fetchImpl, tools: [readTool] };
  const model = name === "deepseek" ? "deepseek-v4-pro" : "kimi-k3";
  const provider = name === "deepseek"
    ? new DeepSeekProvider({ ...config, model })
    : new KimiProvider({ ...config, model });
  const chatStream = provider.chatStream.bind(provider);
  vi.spyOn(provider, "chatStream").mockImplementation((input, emit, options) =>
    chatStream(input, chunk => { chunks.push(chunk); emit(chunk); }, options));
  const { session } = mkSession({ provider, services: {
    providerService: new SessionProviderService({ initialProvider: provider }),
  } });
  Object.assign(session.config, { model });
  const ctx = mkCtx({ modelInfo: { ...mkCtx().modelInfo, slug: model }, collaborationMode: { model } });
  const state = buildInitialTurnState(ctx, { role: "user", content: "Read the file" });
  const pending = streamModel(state, ctx, session, {
    input: state.messages, tools: [readTool], parallelToolCalls: false,
    baseInstructions: "", maxOutputTokens: 8192,
  }).then(() => undefined, error => error);
  return { chunks, fetchImpl, pending };
}

describe.each(["deepseek", "kimi"] as const)("%s buffered tool progress", name => {
  test("slow tool arguments survive reasoning and idle deadlines without early dispatch", async () => {
    vi.useFakeTimers();
    const parts = ['{"file_path":"', ...Array.from({ length: 10 }, (_, i) => `folder${i}/`), 'note.txt"}'];
    const run = probe(name, parts.map((arguments_, index) => ({ tool_calls: [{
      index: 0, ...(index === 0 ? { id: "read-1", type: "function" } : {}),
      function: { ...(index === 0 ? { name: "FileRead" } : {}), arguments: arguments_ },
    }] })));
    expect(parts.length * 60_000).toBeGreaterThan(REASONING_NO_PROGRESS_MS);
    for (let i = 1; i < parts.length; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run.chunks.every(chunk => !chunk.toolCalls && !chunk.toolInputDelta && chunk.content === "")).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await run.pending).toBeUndefined();
    expect(run.fetchImpl).toHaveBeenCalledOnce();
    expect(run.chunks.filter(chunk => chunk.bufferedContentProgress)).toHaveLength(parts.length);
    expect(run.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([
      { id: "read-1", name: "FileRead", arguments: parts.join("") },
    ]);
    expect(run.chunks.filter(chunk => chunk.toolCalls?.length).every(chunk => chunk.done)).toBe(true);
  });

  test.each(["", "   "])("empty tool argument deltas (%j) cannot keep reasoning alive", async arguments_ => {
    vi.useFakeTimers();
    const run = probe(name, Array.from({ length: 4 }, () => ({ tool_calls: [{
      index: 0, function: { arguments: arguments_ },
    }] })));
    await vi.advanceTimersByTimeAsync(REASONING_NO_PROGRESS_MS + 1);
    expect((await run.pending).cause).toMatchObject({ reason: "stream_no_progress" });
    expect(run.fetchImpl).toHaveBeenCalledOnce();
    expect(run.chunks.some(chunk => chunk.bufferedContentProgress || chunk.toolCalls)).toBe(false);
  });
});

function delayedTerminalProbe(useResponsesApi: boolean, incomplete: boolean, repeat = false) {
  const chunks: LLMStreamChunk[] = [];
  const args = incomplete ? '{"file_path":"unfinished' : '{"file_path":"note.txt"}';
  const item = { type: "function_call", id: "fc_read", call_id: "read-1", name: "FileRead", arguments: args };
  let providerSignal: AbortSignal | null | undefined;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    providerSignal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (data: object) => controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`),
        );
        const emitItem = () => emit(useResponsesApi
          ? { type: "response.output_item.done", item }
          : { choices: [{ index: 0, delta: { tool_calls: [{
              index: 0, id: item.call_id, type: "function",
              function: { name: item.name, arguments: args },
            }] } }] });
        const itemTimer = repeat ? undefined : setTimeout(emitItem, 45_000);
        const repeatTimer = repeat ? setInterval(emitItem, 45_000) : undefined;
        const terminalTimer = setTimeout(() => {
          cleanup();
          emit(useResponsesApi
            ? { type: incomplete ? "response.incomplete" : "response.completed", response: {
                status: incomplete ? "incomplete" : "completed", output: [],
                ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
              } }
            : { choices: [{ index: 0, delta: {}, finish_reason: incomplete ? "length" : "tool_calls" }] });
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        }, repeat ? 180_000 : 90_000);
        const cleanup = () => {
          clearTimeout(itemTimer);
          clearInterval(repeatTimer);
          clearTimeout(terminalTimer);
          providerSignal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => { cleanup(); controller.error(providerSignal?.reason); };
        providerSignal?.addEventListener("abort", onAbort, { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } });
  });
  const provider = new OpenAIProvider({ apiKey: "dummy-test", model: "gpt-5", useResponsesApi, fetchImpl });
  const chatStream = provider.chatStream.bind(provider);
  const chatStreamSpy = vi.spyOn(provider, "chatStream").mockImplementation((input, emit, options) =>
    chatStream(input, chunk => { chunks.push(chunk); emit(chunk); }, options));
  const { session } = mkSession({ provider, services: {
    providerService: new SessionProviderService({ initialProvider: provider }),
  } });
  vi.spyOn(session.services.configStore!, "current").mockReturnValue({
    ...session.services.configStore!.current(), stream_watchdog_timeout_ms: 60_000,
  });
  const ctx = mkCtx();
  const state = buildInitialTurnState(ctx, { role: "user", content: "Read the file" });
  const pending = streamModel(state, ctx, session, {
    input: state.messages, tools: [readTool], parallelToolCalls: false,
    baseInstructions: "", maxOutputTokens: 8192,
  }).then(() => undefined, error => error);
  return { chunks, fetchImpl, chatStreamSpy, pending, signal: () => providerSignal };
}

describe.each([true, false])("delayed terminal tool progress (Responses=%s)", useResponsesApi => {
  test.each([false, true])("keeps the 60s watchdog alive until the 90s terminal (incomplete=%s)", async incomplete => {
    vi.useFakeTimers();
    const run = delayedTerminalProbe(useResponsesApi, incomplete);
    await vi.advanceTimersByTimeAsync(45_000);
    const beforeTerminal = [...run.chunks];
    await vi.advanceTimersByTimeAsync(45_001);
    expect(await run.pending).toBeUndefined();
    expect(run.signal()?.aborted).toBe(false);
    expect(run.fetchImpl).toHaveBeenCalledOnce();
    // Even malformed arguments signal progress without leaking tool text or
    // anything the streaming executor could dispatch before the terminal.
    expect(beforeTerminal).toEqual([{ content: "", done: false, bufferedContentProgress: true }]);
    const response = await run.chatStreamSpy.mock.results[0]!.value;
    expect(response).toMatchObject(incomplete
      ? { finishReason: "length", toolCalls: [] }
      : { finishReason: "tool_calls", toolCalls: [{ id: "read-1", name: "FileRead", arguments: '{"file_path":"note.txt"}' }] });
    if (incomplete) expect(run.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
    expect(run.chunks.at(-1)?.done).toBe(true);
  });
});

test("replayed Responses items cannot keep the idle watchdog alive", async () => {
  vi.useFakeTimers();
  const run = delayedTerminalProbe(true, false, true);
  await vi.advanceTimersByTimeAsync(105_001);
  expect((await run.pending).message).toMatch(/^stream_idle:/);
  expect(run.fetchImpl).toHaveBeenCalledOnce();
  expect(run.chunks).toEqual([{ content: "", done: false, bufferedContentProgress: true }]);
});
