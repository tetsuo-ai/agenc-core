import { afterEach, describe, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import type { LLMStreamChunk } from "../../../../src/llm/types.js";

afterEach(() => vi.useRealTimers());
const encode = (text: string) => new TextEncoder().encode(text);
const event = (type: string, fields: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const complete = event("response.completed", { response: {
  id: "synthetic-response", status: "completed",
  output: [{ type: "function_call", call_id: "call-1", name: "Write", arguments: '{"content":"test"}' }],
  usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
} });
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

function probe(initial = complete, timeoutMs?: number) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let pulled = false;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull(value) { if (!pulled) { pulled = true; value.enqueue(encode(initial)); } },
    cancel,
  }, { highWaterMark: 0 });
  const caller = new AbortController();
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body,
    { headers: { "content-type": "text/event-stream" } }));
  const provider = new OpenAIProvider({ apiKey: "synthetic-unused", model: "gpt-6-luna",
    useResponsesApi: true, fetchImpl, timeoutMs });
  const chunks: LLMStreamChunk[] = [];
  let settled = false;
  const pending = provider.chatStream([{ role: "user", content: "Synthetic" }],
    chunk => chunks.push(chunk), { singleWireAttempt: true, signal: caller.signal });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  return { controller, caller, body, cancel, chunks, pending, fetchImpl, isSettled: () => settled };
}

describe("Responses physical EOF ownership", () => {
  test.each(["", "data: [DONE]\n\n", ": keepalive\n\n", ": final keepalive\n", ": final keepalive"])(
    "withholds final tools and usage until physical EOF (suffix %j)", async suffix => {
      const run = probe(complete + suffix);
      try {
        await flush();
        expect(run.isSettled()).toBe(false);
        expect(run.chunks.some(chunk => chunk.done || chunk.toolCalls?.length)).toBe(false);
        run.controller.close();
        const result = await run.pending;
        expect(result.toolCalls).toHaveLength(1);
        expect(result.usage?.totalTokens).toBe(10);
        expect(run.cancel).not.toHaveBeenCalled();
        expect(run.body.locked).toBe(false);
      } finally { run.caller.abort(); await run.pending.catch(() => {}); }
    },
  );

  const tails = [
    event("error", { message: "late failure" }),
    event("response.failed", { response: { status: "failed" } }),
    complete,
    event("response.output_text.delta", { delta: "late text" }),
    "data: malformed\n\n",
    "data: null\n\n",
    "data: [DONE]\n\n" + event("error", { message: "after marker" }),
  ];
  test.each(tails.flatMap(tail => [true, false].map(sameChunk => ({ tail, sameChunk }))))(
    "rejects substantive trailing data (sameChunk=$sameChunk, $tail)", async ({ tail, sameChunk }) => {
      const run = probe(complete + (sameChunk ? tail : ""));
      try {
        await flush();
        if (!sameChunk) run.controller.enqueue(encode(tail));
        await expect(run.pending).rejects.toThrow();
        expect(run.chunks.some(chunk => chunk.done || chunk.toolCalls?.length)).toBe(false);
        expect(run.fetchImpl).toHaveBeenCalledOnce();
      } finally { run.caller.abort(); await run.pending.catch(() => {}); }
    },
  );

  test("rejects an incomplete trailing frame at EOF", async () => {
    const run = probe(complete + "data: {\"type\":\"error\"}");
    await flush();
    run.controller.close();
    await expect(run.pending).rejects.toThrow();
    expect(run.chunks.some(chunk => chunk.done || chunk.toolCalls?.length)).toBe(false);
  });

  test("preserves cancellation after terminal payload", async () => {
    const run = probe();
    await flush();
    run.caller.abort(new Error("synthetic cancellation"));
    await expect(run.pending).rejects.toThrow();
    expect(run.chunks.some(chunk => chunk.done || chunk.toolCalls?.length)).toBe(false);
    expect(run.fetchImpl).toHaveBeenCalledOnce();
    expect(run.body.locked).toBe(false);
  });

  test("keeps the configured deadline active while awaiting EOF", async () => {
    vi.useFakeTimers();
    const run = probe(complete, 100);
    await flush();
    expect(run.isSettled()).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    await expect(run.pending).rejects.toThrow();
    expect(run.chunks.some(chunk => chunk.done || chunk.toolCalls?.length)).toBe(false);
    expect(run.fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("body failure after terminal cannot become success or trigger replay", async () => {
    const run = probe();
    await flush();
    run.controller.error(new Error("synthetic body failure"));
    await expect(run.pending).rejects.toThrow();
    expect(run.chunks.some(chunk => chunk.done || chunk.toolCalls?.length)).toBe(false);
    expect(run.fetchImpl).toHaveBeenCalledOnce();
  });

  test("[DONE] without a completed response is still truncated", async () => {
    const run = probe("data: [DONE]\n\n");
    await flush();
    expect(run.isSettled()).toBe(false);
    run.controller.close();
    await expect(run.pending).rejects.toThrow();
    expect(run.chunks.some(chunk => chunk.done || chunk.toolCalls?.length)).toBe(false);
  });

  test("malformed UTF-8 after terminal cannot be discarded", async () => {
    const run = probe();
    await flush();
    run.controller.enqueue(new Uint8Array([0xff]));
    await expect(run.pending).rejects.toThrow();
    expect(run.chunks.some(chunk => chunk.done || chunk.toolCalls?.length)).toBe(false);
  });

  test("literal CR cannot repair malformed JSON into a completed response", async () => {
    const run = probe(complete.replace('"type":"response.completed"', '"type":"respon\rse.completed"'));
    await expect(run.pending).rejects.toThrow();
    expect(run.chunks.some(chunk => chunk.done || chunk.toolCalls?.length)).toBe(false);
  });

  test.each(["\r", "\r\n"])("accepts SSE line boundaries %j without repairing JSON", async delimiter => {
    const run = probe(complete.replaceAll("\n", delimiter));
    await flush();
    run.controller.close();
    expect((await run.pending).toolCalls).toHaveLength(1);
  });

  test("handles CRLF split between body chunks", async () => {
    const wire = complete.replaceAll("\n", "\r\n");
    const boundary = wire.indexOf("\r") + 1;
    const run = probe(wire.slice(0, boundary));
    await flush();
    run.controller.enqueue(encode(wire.slice(boundary)));
    run.controller.close();
    expect((await run.pending).toolCalls).toHaveLength(1);
  });
});
