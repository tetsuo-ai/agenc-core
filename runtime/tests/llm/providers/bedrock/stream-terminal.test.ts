import { describe, expect, it, vi } from "vitest";

import {
  LLMInvalidResponseError,
  LLMStreamTruncatedError,
} from "../../errors.js";
import type { StreamProgressCallback } from "../../types.js";
import { BedrockProvider } from "./index.js";

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function eventStreamFrame(payload: Record<string, unknown>): Uint8Array {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const totalLength = 16 + payloadBytes.length;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, 0, false);
  view.setUint32(8, 0, false);
  frame.set(payloadBytes, 12);
  view.setUint32(totalLength - 4, 0, false);
  return frame;
}

function eventStreamResponse(
  events: readonly Record<string, unknown>[],
): Response {
  return new Response(concatBytes(...events.map(eventStreamFrame)), {
    status: 200,
    headers: { "content-type": "application/vnd.amazon.eventstream" },
  });
}

function providerWithFetch(fetchImpl: typeof fetch): BedrockProvider {
  return new BedrockProvider({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
    model: "amazon.nova-pro-v1:0",
    fetchImpl,
  });
}

function abortableEventStreamResponse(
  events: readonly Record<string, unknown>[],
): typeof fetch {
  return vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(concatBytes(...events.map(eventStreamFrame)));
        const signal = init?.signal;
        if (signal === undefined) return;
        const abort = () => {
          controller.error(
            signal.reason ?? new DOMException("The operation was aborted.", "AbortError"),
          );
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      }),
    );
  });
}

async function collectStream(
  provider: BedrockProvider,
  onChunk: StreamProgressCallback = () => {},
) {
  return provider.chatStream([{ role: "user", content: "hello" }], onChunk);
}

describe("Bedrock stream terminal events", () => {
  it("a complete delta followed by EOF without messageStop is truncated", async () => {
    const chunks: Array<{ content: string; done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        eventStreamResponse([
          {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: { text: "partial" },
            },
          },
        ]),
      ),
    );

    const error = await collectStream(provider, (chunk) => {
      chunks.push({ content: chunk.content, done: chunk.done });
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMStreamTruncatedError);
    expect((error as Error).message).toMatch(/messageStop/i);
    expect(chunks).toEqual([{ content: "partial", done: false }]);
  });

  it("EOF mid-frame is truncated and emits no done chunk", async () => {
    const chunks: Array<{ done: boolean }> = [];
    const complete = eventStreamFrame({
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { text: "Hi" },
      },
    });
    const truncatedHeader = new Uint8Array([0, 0, 0, 80, 0, 0]);
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(concatBytes(complete, truncatedHeader), {
          status: 200,
          headers: { "content-type": "application/vnd.amazon.eventstream" },
        }),
      ),
    );

    const error = await collectStream(provider, (chunk) => {
      chunks.push({ done: chunk.done });
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMStreamTruncatedError);
    expect((error as Error).message).toMatch(/partial event frame/i);
    expect(chunks.some((chunk) => chunk.done)).toBe(false);
  });

  it("messageStop plus trailing usage metadata succeeds", async () => {
    const chunks: Array<{ content: string; done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        eventStreamResponse([
          {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: { text: "Hello" },
            },
          },
          { messageStop: { stopReason: "end_turn" } },
          {
            metadata: {
              usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
            },
          },
        ]),
      ),
    );

    const response = await collectStream(provider, (chunk) => {
      chunks.push({ content: chunk.content, done: chunk.done });
    });

    expect(response.content).toBe("Hello");
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toMatchObject({
      promptTokens: 3,
      completionTokens: 1,
      totalTokens: 4,
    });
    expect(chunks).toEqual([
      { content: "Hello", done: false },
      { content: "", done: true },
    ]);
  });

  it("an open tool block at messageStop is a typed provider error", async () => {
    const chunks: Array<{ done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        eventStreamResponse([
          {
            contentBlockStart: {
              contentBlockIndex: 0,
              start: {
                toolUse: { toolUseId: "toolu-1", name: "lookup" },
              },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: { toolUse: { input: "{\"query\":\"status\"}" } },
            },
          },
          { messageStop: { stopReason: "tool_use" } },
        ]),
      ),
    );

    const error = await collectStream(provider, (chunk) => {
      chunks.push({ done: chunk.done });
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMInvalidResponseError);
    expect((error as Error).message).toMatch(/open content or tool block/i);
    expect(chunks.some((chunk) => chunk.done)).toBe(false);
  });

  it("malformed JSON frames are invalid rather than discarded", async () => {
    const complete = eventStreamFrame({
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { text: "Hi" },
      },
    });
    const payload = new TextEncoder().encode("{not-json");
    const totalLength = 16 + payload.length;
    const bad = new Uint8Array(totalLength);
    const view = new DataView(bad.buffer);
    view.setUint32(0, totalLength, false);
    view.setUint32(4, 0, false);
    view.setUint32(8, 0, false);
    bad.set(payload, 12);
    view.setUint32(totalLength - 4, 0, false);
    const chunks: Array<{ done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(concatBytes(complete, bad), {
          status: 200,
          headers: { "content-type": "application/vnd.amazon.eventstream" },
        }),
      ),
    );

    const error = await collectStream(provider, (chunk) => {
      chunks.push({ done: chunk.done });
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMInvalidResponseError);
    expect((error as Error).message).toMatch(/Malformed JSON/i);
    expect(chunks.some((chunk) => chunk.done)).toBe(false);
  });

  it("cancellation after a content delta rejects without a done chunk", async () => {
    const provider = providerWithFetch(
      abortableEventStreamResponse([
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { text: "partial" },
          },
        },
      ]),
    );
    const caller = new AbortController();
    const chunks: Array<{ content: string; done: boolean }> = [];
    const pending = provider.chatStream(
      [{ role: "user", content: "hello" }],
      (chunk) => chunks.push({ content: chunk.content, done: chunk.done }),
      { signal: caller.signal },
    );

    await vi.waitFor(() => {
      expect(chunks).toEqual([{ content: "partial", done: false }]);
    });
    caller.abort();

    await expect(pending).rejects.toThrow();
    expect(chunks.some((chunk) => chunk.done)).toBe(false);
  });
});
