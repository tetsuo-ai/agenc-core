import { describe, expect, test, vi } from "vitest";

import type { LLMStreamChunk } from "../../types.js";
import { GrokProvider } from "./adapter.js";

function buildXaiResponse(id: string, text: string): Record<string, unknown> {
  return {
    id,
    status: "completed",
    incomplete_details: null,
    model: "grok-4.3",
    output_text: text,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    },
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

describe("Grok adapter forwards reasoning_summary_text deltas", () => {
  test("response.reasoning_summary_text.delta becomes a reasoningSummaryDelta chunk", async () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4.3",
    });
    const create = vi.fn(() =>
      withResponse(
        streamFromEvents([
          {
            type: "response.reasoning_summary_text.delta",
            delta: "Let me think about ",
            summary_index: 0,
          },
          {
            type: "response.reasoning_summary_text.delta",
            delta: "the projectile.",
            summary_index: 0,
          },
          {
            type: "response.output_text.delta",
            delta: "Final answer: 30√2 m/s",
          },
          {
            type: "response.completed",
            response: buildXaiResponse("resp_reason", "Final answer: 30√2 m/s"),
          },
        ]),
      ),
    );
    (provider as any).client = {
      responses: { create },
    };
    const chunks: LLMStreamChunk[] = [];
    const result = await provider.chatStream(
      [{ role: "user", content: "physics question" }],
      (chunk) => chunks.push(chunk),
    );

    const reasoningChunks = chunks.filter((c) => c.reasoningSummaryDelta);
    expect(reasoningChunks).toHaveLength(2);
    expect(reasoningChunks[0]!.reasoningSummaryDelta).toEqual({
      delta: "Let me think about ",
      summaryIndex: 0,
    });
    expect(reasoningChunks[1]!.reasoningSummaryDelta).toEqual({
      delta: "the projectile.",
      summaryIndex: 0,
    });

    // Visible content path unaffected
    const contentChunks = chunks.filter((c) => c.content && c.content.length > 0);
    expect(contentChunks.map((c) => c.content)).toEqual(["Final answer: 30√2 m/s"]);
    expect(result.content).toBe("Final answer: 30√2 m/s");
  });

  test("missing summary_index defaults to 0 (xAI does not always include it)", async () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4.3",
    });
    const create = vi.fn(() =>
      withResponse(
        streamFromEvents([
          {
            type: "response.reasoning_summary_text.delta",
            delta: "Reasoning...",
          },
          {
            type: "response.completed",
            response: buildXaiResponse("resp_no_idx", "ok"),
          },
        ]),
      ),
    );
    (provider as any).client = {
      responses: { create },
    };
    const chunks: LLMStreamChunk[] = [];
    await provider.chatStream(
      [{ role: "user", content: "go" }],
      (chunk) => chunks.push(chunk),
    );
    const reasoning = chunks.find((c) => c.reasoningSummaryDelta);
    expect(reasoning).toBeDefined();
    expect(reasoning!.reasoningSummaryDelta).toEqual({
      delta: "Reasoning...",
      summaryIndex: 0,
    });
  });

  test("emits final text found only in the completed response output envelope", async () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4.3",
    });
    const completed = buildXaiResponse("resp_envelope_only", "visible answer");
    delete completed.output_text;
    const create = vi.fn(() =>
      withResponse(
        streamFromEvents([
          {
            type: "response.reasoning_summary_text.delta",
            delta: "I should answer briefly.",
          },
          { type: "response.completed", response: completed },
        ]),
      ),
    );
    (provider as any).client = { responses: { create } };
    const chunks: LLMStreamChunk[] = [];

    const result = await provider.chatStream(
      [{ role: "user", content: "go" }],
      (chunk) => chunks.push(chunk),
    );

    expect(result.content).toBe("visible answer");
    expect(
      chunks
        .filter((chunk) => chunk.content.length > 0)
        .map((chunk) => chunk.content),
    ).toEqual(["visible answer"]);
  });

  test("empty delta string is dropped — does not emit a chunk", async () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4.3",
    });
    const create = vi.fn(() =>
      withResponse(
        streamFromEvents([
          {
            type: "response.reasoning_summary_text.delta",
            delta: "",
            summary_index: 0,
          },
          {
            type: "response.completed",
            response: buildXaiResponse("resp_empty", "ok"),
          },
        ]),
      ),
    );
    (provider as any).client = {
      responses: { create },
    };
    const chunks: LLMStreamChunk[] = [];
    await provider.chatStream(
      [{ role: "user", content: "go" }],
      (chunk) => chunks.push(chunk),
    );
    expect(chunks.some((c) => c.reasoningSummaryDelta)).toBe(false);
  });

  test("multiple summary indices are passed through unchanged", async () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4.3",
    });
    const create = vi.fn(() =>
      withResponse(
        streamFromEvents([
          {
            type: "response.reasoning_summary_text.delta",
            delta: "Block A",
            summary_index: 0,
          },
          {
            type: "response.reasoning_summary_text.delta",
            delta: "Block B",
            summary_index: 1,
          },
          {
            type: "response.completed",
            response: buildXaiResponse("resp_multi", "ok"),
          },
        ]),
      ),
    );
    (provider as any).client = {
      responses: { create },
    };
    const chunks: LLMStreamChunk[] = [];
    await provider.chatStream(
      [{ role: "user", content: "go" }],
      (chunk) => chunks.push(chunk),
    );
    const reasoningChunks = chunks.filter((c) => c.reasoningSummaryDelta);
    expect(reasoningChunks.map((c) => c.reasoningSummaryDelta)).toEqual([
      { delta: "Block A", summaryIndex: 0 },
      { delta: "Block B", summaryIndex: 1 },
    ]);
  });
});
