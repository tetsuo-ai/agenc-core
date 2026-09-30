import { describe, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import type { LLMStreamChunk } from "../../../../src/llm/types.js";

const call = (id = "call-1", args = '{"content":"synthetic"}') => ({
  type: "function_call", call_id: id, name: "Write", arguments: args,
});
const frame = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const item = (value: Record<string, unknown>) => frame("response.output_item.done", { item: value });
const usage = { input_tokens: 3, output_tokens: 7, total_tokens: 10 };

function probe(frames: string[]) {
  let terminalRead = false;
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === frames.length) { controller.close(); return; }
        const next = frames[index++]!;
        if (/event: response\.(completed|incomplete|failed)/.test(next)) terminalRead = true;
        controller.enqueue(new TextEncoder().encode(next));
      },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } },
  ));
  const provider = new OpenAIProvider({ apiKey: "synthetic-unused", model: "gpt-6-luna",
    useResponsesApi: true, fetchImpl });
  const chunks: LLMStreamChunk[] = [];
  const callsBeforeTerminal: LLMStreamChunk[] = [];
  const pending = provider.chatStream([{ role: "user", content: "Synthetic test" }], chunk => {
    chunks.push(chunk);
    if (!terminalRead && chunk.toolCalls?.length) callsBeforeTerminal.push(chunk);
  }, { singleWireAttempt: true });
  return { chunks, pending, callsBeforeTerminal, fetchImpl };
}

describe("Responses executable-call terminal contract", () => {
  test.each([true, false])("error terminal cannot be forgotten by later success (item first=%s)", async first => {
    const failure = frame("error", { code: "invalid_request_error", status: 400, message: "Synthetic error" });
    const run = probe([...(first ? [item(call()), failure] : [failure, item(call())]),
      frame("response.completed", { response: { status: "completed", output: [call()], usage } })]);
    await expect(run.pending).rejects.toThrow();
    expect(run.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
    expect(run.fetchImpl).toHaveBeenCalledOnce();
  });
  test.each([null, {}, "malformed"].map(output => ({ output })))(
    "malformed terminal output $output is not an omitted call list", async ({ output }) => {
      const run = probe([item(call()), frame("response.completed", {
        response: { status: "completed", output, usage },
      })]);
      const result = await run.pending;
      expect(result.toolCalls).toEqual([]);
      expect(result.finishReason).toBe("error");
      expect(run.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
    },
  );

  test.each([[], null, "malformed"])("invalid terminal response %s is not legacy success", async response => {
    const run = probe([item(call()), frame("response.completed", { response })]);
    await expect(run.pending).rejects.toThrow();
    expect(run.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
  });
  test.each([["completed"], {}, 1, true, null].map(status => ({ status })))(
    "non-string completed status $status cannot authorize calls", async ({ status }) => {
      const run = probe([item(call()), frame("response.completed", {
        response: { status, output: [call()], usage },
      })]);
      expect((await run.pending).toolCalls).toEqual([]);
      expect(run.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
    },
  );

  test.each(["response.incomplete", "response.failed", ["response.completed"], null])(
    "conflicting terminal event data type %s cannot authorize calls", async type => {
      const run = probe([item(call()), frame("response.completed", {
        type, response: { status: "completed", output: [call()], usage },
      })]);
      expect((await run.pending).toolCalls).toEqual([]);
      expect(run.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
    },
  );
  test.each([
    ["response.incomplete", "incomplete", "max_output_tokens", "length"],
    ["response.incomplete", "incomplete", "content_filter", "content_filter"],
    ["response.incomplete", "incomplete", "error", "error"],
    ["response.incomplete", "incomplete", "unknown", "error"],
    ["response.incomplete", undefined, "max_output_tokens", "length"],
    ["response.incomplete", "completed", "max_output_tokens", "error"],
    ["response.completed", "incomplete", "max_output_tokens", "length"],
    ["response.completed", "failed", "", "error"],
    ["response.completed", "cancelled", "", "error"],
    ["response.completed", "expired", "", "error"],
    ["response.completed", "in_progress", "", "error"],
  ])("%s / %s / %s never exposes calls", async (event, status, reason, finishReason) => {
    const run = probe([
      frame("response.output_text.delta", { delta: "Partial." }),
      item(call()), item(call("call-2", '{"unfinished')),
      frame(event!, { response: { status, incomplete_details: { reason }, output: [], usage } }),
    ]);
    const result = await run.pending;
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe(finishReason);
    expect(result.content).toBe("Partial.");
    expect(result.usage).toMatchObject({ promptTokens: 3, completionTokens: 7, totalTokens: 10 });
    expect(run.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
    expect(run.callsBeforeTerminal).toEqual([]);
    expect(run.fetchImpl).toHaveBeenCalledOnce();
  });

  test.each(["completed", undefined])("successful event (%s) supports omitted calls after terminal only", async status => {
    const run = probe([item(call()), frame("response.completed", { response: { status, output: [], usage } })]);
    const result = await run.pending;
    expect(result.toolCalls).toEqual([{ id: "call-1", name: "Write", arguments: '{"content":"synthetic"}' }]);
    expect(result.finishReason).toBe("tool_calls");
    expect(run.callsBeforeTerminal).toEqual([]);
    expect(run.chunks.filter(chunk => chunk.toolCalls?.length)).toEqual([
      { content: "", done: true, toolCalls: result.toolCalls },
    ]);
  });

  test("present terminal call set wins over stale, extra and contradictory buffered calls", async () => {
    const finalCall = call("call-1", '{"content":"final"}');
    const run = probe([item(call()), item(call("call-2")),
      frame("response.completed", { response: { status: "completed", output: [finalCall], usage } })]);
    const result = await run.pending;
    expect(result.toolCalls).toEqual([{ id: "call-1", name: "Write", arguments: finalCall.arguments }]);
    expect(run.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual(result.toolCalls);
  });

  test("a malformed rejected buffered call does not poison an authoritative valid terminal set", async () => {
    const run = probe([item({ ...call(), name: "" }), frame("response.completed", {
      response: { status: "completed", output: [call("final")], usage },
    })]);
    expect((await run.pending).toolCalls.map(value => value.id)).toEqual(["final"]);
  });

  test("malformed completion preserves already-visible text and usage, never partial calls", async () => {
    const run = probe([frame("response.output_text.delta", { delta: "Partial." }),
      item(call()), item({ ...call("invalid"), name: "" }),
      frame("response.completed", { response: { status: "completed", output: [], usage } })]);
    const result = await run.pending;
    expect(result).toMatchObject({ content: "Partial.", partial: true, finishReason: "error", toolCalls: [] });
    expect(result.usage).toMatchObject({ totalTokens: 10 });
    expect(run.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
  });

  test("buffered snapshots signal novel progress, not duplicates or alternating replays", async () => {
    const first = call(), second = call("call-1", '{"content":"second"}');
    const run = probe([item(first), item(first), item(second), item(first),
      frame("response.completed", { response: { status: "completed", output: [second] } })]);
    await run.pending;
    expect(run.chunks.filter(chunk => chunk.bufferedContentProgress)).toHaveLength(2);
    expect(run.chunks.filter(chunk => !chunk.done).every(chunk => !chunk.toolCalls && !chunk.toolInputDelta)).toBe(true);
  });

  test("EOF after a valid item never publishes a call", async () => {
    const run = probe([item(call())]);
    await expect(run.pending).rejects.toThrow();
    expect(run.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
  });

  test("failed terminal never publishes a previously buffered call", async () => {
    const run = probe([item(call()), frame("response.failed", {
      response: { status: "failed", error: { message: "Synthetic failure" } },
    })]);
    await expect(run.pending).rejects.toThrow();
    expect(run.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
  });
});
