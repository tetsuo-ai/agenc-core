import { describe, expect, test, vi } from "vitest";

import {
  LLMInvalidResponseError,
  LLMStreamTruncatedError,
} from "../../errors.js";
import { BUILT_IN_PROVIDER_DEFAULT_MODELS } from "../../registry/provider-info.js";
import type { LLMTool, StreamProgressCallback } from "../../types.js";
import { OpenAICompatibleProvider } from "./index.js";

const ECHO_TOOL: LLMTool = {
  type: "function",
  function: {
    name: "system.echo",
    description: "Echo text",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
};

function chunkedSseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function providerWithFetch(
  fetchImpl: typeof fetch,
  tools: readonly LLMTool[] = [],
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    model: BUILT_IN_PROVIDER_DEFAULT_MODELS["openai-compatible"],
    fetchImpl,
    ...(tools.length > 0 ? { tools: [...tools] } : {}),
  });
}

function abortableSseResponse(firstChunk: string): typeof fetch {
  const encoder = new TextEncoder();
  return vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(firstChunk));
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
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
  });
}

async function collectStream(
  provider: OpenAICompatibleProvider,
  onChunk: StreamProgressCallback = () => {},
) {
  return provider.chatStream([{ role: "user", content: "hello" }], onChunk);
}

describe("OpenAI-compatible stream terminal events", () => {
  test("a complete delta followed by EOF without finish_reason or [DONE] is truncated", async () => {
    const chunks: Array<{ content: string; done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        chunkedSseResponse([
          'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
        ]),
      ),
    );

    const error = await collectStream(provider, (chunk) => {
      chunks.push({ content: chunk.content, done: chunk.done });
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMStreamTruncatedError);
    expect((error as Error).message).toMatch(/finish_reason or \[DONE\]/i);
    expect(chunks).toEqual([{ content: "partial", done: false }]);
  });

  test("EOF mid-frame is truncated and emits no done chunk", async () => {
    const chunks: Array<{ done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        chunkedSseResponse([
          'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
          'data: {"choices":[{"index":0,"finish_reason":"st',
        ]),
      ),
    );

    const error = await collectStream(provider, (chunk) => {
      chunks.push({ done: chunk.done });
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMStreamTruncatedError);
    expect((error as Error).message).toMatch(/unterminated event/i);
    expect(chunks.some((chunk) => chunk.done)).toBe(false);
  });

  test("a choice finish_reason plus trailing usage metadata succeeds", async () => {
    const chunks: Array<{ content: string; done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        chunkedSseResponse([
          'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
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

  test("[DONE] without finish_reason is a valid text terminal", async () => {
    const chunks: Array<{ content: string; done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        chunkedSseResponse([
          'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    );

    const response = await collectStream(provider, (chunk) => {
      chunks.push({ content: chunk.content, done: chunk.done });
    });

    expect(response.content).toBe("Hello");
    expect(response.finishReason).toBe("stop");
    expect(chunks).toEqual([
      { content: "Hello", done: false },
      { content: "", done: true },
    ]);
  });

  test("open streamed tool calls at [DONE] fail with a typed provider error", async () => {
    const chunks: Array<{ done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        chunkedSseResponse([
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"system.echo","arguments":"{\\"text\\":\\"hi\\"}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
      [ECHO_TOOL],
    );

    const error = await collectStream(provider, (chunk) => {
      chunks.push({ done: chunk.done });
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMInvalidResponseError);
    expect((error as Error).message).toMatch(
      /tool calls.*finish_reason=tool_calls/i,
    );
    expect(chunks.some((chunk) => chunk.done)).toBe(false);
  });

  test("malformed JSON frames are invalid rather than discarded", async () => {
    const chunks: Array<{ done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        chunkedSseResponse([
          'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
          "data: {not-json}\n\n",
          "data: [DONE]\n\n",
        ]),
      ),
    );

    const error = await collectStream(provider, (chunk) => {
      chunks.push({ done: chunk.done });
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMInvalidResponseError);
    expect((error as Error).message).toMatch(/Malformed JSON/i);
    expect(chunks.some((chunk) => chunk.done)).toBe(false);
  });

  test("cancellation after a content delta rejects without a done chunk", async () => {
    const provider = providerWithFetch(
      abortableSseResponse(
        'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      ),
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
