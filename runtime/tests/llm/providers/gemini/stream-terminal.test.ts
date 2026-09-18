import { describe, expect, test, vi } from "vitest";

import {
  LLMInvalidResponseError,
  LLMStreamTruncatedError,
} from "../../errors.js";
import type { StreamProgressCallback } from "../../types.js";
import { createGeminiEndpointPlan } from "./endpoint-plan.js";
import { GeminiProvider } from "./index.js";

const endpointPlan = createGeminiEndpointPlan();

function apiKeyCredentialPlan(credential = "gemini-test") {
  return {
    kind: "api-key" as const,
    credential,
    source: "factory" as const,
  };
}

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

function providerWithFetch(fetchImpl: typeof fetch): GeminiProvider {
  return new GeminiProvider({
    credentialPlan: apiKeyCredentialPlan(),
    endpointPlan,
    model: "gemini-2.5-pro",
    fetchImpl,
  });
}

function abortableSseResponse(firstChunk: string): {
  readonly fetchImpl: typeof fetch;
} {
  const encoder = new TextEncoder();
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
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
  return { fetchImpl };
}

async function collectStream(
  provider: GeminiProvider,
  onChunk: StreamProgressCallback = () => {},
) {
  return provider.chatStream([{ role: "user", content: "hello" }], onChunk);
}

describe("Gemini stream terminal events", () => {
  test("a complete delta followed by EOF without finishReason is truncated", async () => {
    const chunks: Array<{ content: string; done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        chunkedSseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
        ]),
      ),
    );

    const error = await collectStream(provider, (chunk) => {
      chunks.push({ content: chunk.content, done: chunk.done });
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMStreamTruncatedError);
    expect((error as Error).message).toMatch(/finishReason/i);
    expect(chunks).toEqual([{ content: "partial", done: false }]);
  });

  test("EOF mid-frame is truncated and emits no done chunk", async () => {
    const chunks: Array<{ done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        chunkedSseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]},"finishReason":"STOP"}]}\n\n',
          'data: {"usageMetadata":{"promptTokenCount":1',
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

  test("a candidate finishReason plus trailing usage metadata succeeds", async () => {
    const chunks: Array<{ content: string; done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        chunkedSseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}\n\n',
          'data: {"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}\n\n',
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

  test("a recognized prompt-level blockReason is a successful terminal", async () => {
    const chunks: Array<{ done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        chunkedSseResponse([
          'data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n',
        ]),
      ),
    );

    const response = await collectStream(provider, (chunk) => {
      chunks.push({ done: chunk.done });
    });

    expect(response.finishReason).toBe("content_filter");
    expect(chunks).toEqual([{ done: true }]);
  });

  test("malformed JSON frames are invalid rather than discarded", async () => {
    const chunks: Array<{ done: boolean }> = [];
    const provider = providerWithFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        chunkedSseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
          "data: {not-json}\n\n",
          'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
        ]),
      ),
    );

    const error = await collectStream(provider, (chunk) => {
      chunks.push({ done: chunk.done });
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LLMInvalidResponseError);
    expect((error as Error).message).toMatch(/Malformed JSON in Gemini SSE/i);
    expect(chunks.some((chunk) => chunk.done)).toBe(false);
  });

  test("cancellation after a content delta rejects without a done chunk", async () => {
    const { fetchImpl } = abortableSseResponse(
      'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
    );
    const provider = providerWithFetch(fetchImpl);
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
