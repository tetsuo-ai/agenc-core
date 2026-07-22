import { describe, expect, test, vi } from "vitest";

import type { LLMStreamChunk } from "../../types.js";
import { GrokProvider } from "./adapter.js";

// The turn-level stream watchdog (phases/stream-model.ts) only sees
// LLMStreamChunks: any provider event the adapter consumes without calling
// onChunk is invisible to it. Before this suite's fixes, a model streaming
// one long tool call (response.function_call_arguments.delta) or a raw
// reasoning phase produced zero chunks, so the 90s session watchdog fired
// stream_idle on a healthy stream and forced a reconnect loop.

function buildXaiResponse(id: string, text: string): Record<string, unknown> {
  return {
    id,
    status: "completed",
    incomplete_details: null,
    model: "grok-4.5",
    output_text: text,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

function withResponse<T>(data: T) {
  return {
    withResponse: async () => ({
      data,
      response: new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      request_id: null,
    }),
  };
}

function streamFromEvents(
  events: readonly Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function makeProvider(events: readonly Record<string, unknown>[]): GrokProvider {
  const provider = new GrokProvider({ apiKey: "xai-test", model: "grok-4.5" });
  (provider as any).client = {
    responses: { create: vi.fn(() => withResponse(streamFromEvents(events))) },
  };
  return provider;
}

describe("Grok adapter stream liveness", () => {
  test("function-call argument streaming emits toolInputBlockStart and toolInputDelta chunks", async () => {
    const provider = makeProvider([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "item_1",
          call_id: "call_abc",
          name: "Write",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_1",
        output_index: 0,
        delta: '{"file_path":"/tmp/a",',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_1",
        output_index: 0,
        delta: '"content":"hello"}',
      },
      {
        type: "response.completed",
        response: buildXaiResponse("resp_tool", ""),
      },
    ]);
    const chunks: LLMStreamChunk[] = [];
    await provider.chatStream([{ role: "user", content: "write it" }], (c) =>
      chunks.push(c),
    );

    const start = chunks.find((c) => c.toolInputBlockStart);
    expect(start?.toolInputBlockStart).toMatchObject({
      callId: "call_abc",
      index: 0,
      contentBlock: { type: "tool_use", id: "call_abc", name: "Write" },
    });
    const deltas = chunks
      .filter((c) => c.toolInputDelta)
      .map((c) => c.toolInputDelta!);
    expect(deltas).toEqual([
      { callId: "call_abc", index: 0, partialJson: '{"file_path":"/tmp/a",' },
      { callId: "call_abc", index: 0, partialJson: '"content":"hello"}' },
    ]);
  });

  test("every stream event produces at least one chunk (watchdog liveness), including unknown types", async () => {
    const events: Record<string, unknown>[] = [
      { type: "response.created" },
      { type: "response.in_progress" },
      { type: "response.some_future_event_type", payload: { x: 1 } },
      {
        type: "response.function_call_arguments.done",
        item_id: "item_9",
        output_index: 0,
      },
      {
        type: "response.completed",
        response: buildXaiResponse("resp_hb", "done"),
      },
    ];
    const provider = makeProvider(events);
    const chunks: LLMStreamChunk[] = [];
    await provider.chatStream([{ role: "user", content: "go" }], (c) =>
      chunks.push(c),
    );

    // 4 non-terminal events must each yield a chunk, plus the final
    // done:true chunk and the completed-envelope content fallback.
    const nonTerminal = chunks.filter((c) => !c.done);
    expect(nonTerminal.length).toBeGreaterThanOrEqual(4);
    expect(chunks.at(-1)?.done).toBe(true);
  });

  test("raw reasoning_text deltas ride the reasoning pipeline in their own index space", async () => {
    const provider = makeProvider([
      {
        type: "response.reasoning_text.delta",
        content_index: 0,
        delta: "thinking hard ",
      },
      {
        type: "response.reasoning_text.delta",
        content_index: 0,
        delta: "about lexers",
      },
      {
        type: "response.reasoning_summary_text.delta",
        summary_index: 0,
        delta: "summary block",
      },
      {
        type: "response.completed",
        response: buildXaiResponse("resp_raw", "ok"),
      },
    ]);
    const chunks: LLMStreamChunk[] = [];
    const result = await provider.chatStream(
      [{ role: "user", content: "reason" }],
      (c) => chunks.push(c),
    );

    const reasoning = chunks
      .filter((c) => c.reasoningSummaryDelta)
      .map((c) => c.reasoningSummaryDelta!);
    expect(reasoning).toHaveLength(3);
    // Raw reasoning lands offset from genuine summary indexes; the summary
    // block keeps its provider index.
    const rawIndexes = reasoning.slice(0, 2).map((r) => r.summaryIndex);
    expect(rawIndexes[0]).toBe(rawIndexes[1]);
    expect(rawIndexes[0]!).toBeGreaterThanOrEqual(10_000);
    expect(reasoning[2]!.summaryIndex).toBe(0);
    // Both blocks materialize as thinking on the final response.
    const texts = (result.thinking ?? []).map((t) => t.text);
    expect(texts).toContain("thinking hard about lexers");
    expect(texts).toContain("summary block");
  });
});
