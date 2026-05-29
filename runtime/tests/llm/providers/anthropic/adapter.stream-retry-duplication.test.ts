import { describe, expect, test, vi } from "vitest";
import { AnthropicProvider } from "./adapter.js";

/**
 * Regression coverage for audit issue #10: the Anthropic adapter's outer catch
 * used to `continue streamAttempts` on a wait/overload fallback decision even
 * after partial `onChunk` text had been emitted, with no
 * `content.length === 0` guard. The consumer would re-append the retried text,
 * doubling rendered output and mid-stream token estimates.
 *
 * The fix guards the outer-catch retry the same way the in-stream `error`
 * branch does — only retrying when nothing has been emitted yet — and surfaces
 * a partial response (`finishReason: "error"`, `partial: true`) when content
 * was already streamed.
 */

/** An SSE response whose body emits `frames`, then errors the stream. */
function sseResponseThenError(frames: string[], error: Error): Response {
  const encoder = new TextEncoder();
  // Enqueue the frames on the first pull and error only on the next pull, so
  // the reader actually receives (and the adapter processes) the buffered
  // frames before the transport error surfaces. Erroring synchronously in the
  // same tick as the enqueue discards the queued chunk under the WHATWG
  // ReadableStream semantics, which would defeat the partial-content coverage.
  let emitted = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!emitted) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        emitted = true;
        return;
      }
      controller.error(error);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const TEXT_DELTA =
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n';

describe("AnthropicProvider stream retry duplication (audit #10)", () => {
  test(
    "does not replay already-emitted chunks when a wait/overload error is " +
      "thrown mid-stream after partial content",
    async () => {
      // The stream emits one text delta and then throws an overloaded_error.
      // Because content was already forwarded to the consumer, the adapter must
      // NOT retry (which would re-emit "partial") — it surfaces a partial
      // response instead.
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
        Promise.resolve(
          sseResponseThenError([TEXT_DELTA], new Error("overloaded_error")),
        )
      );
      const provider = new AnthropicProvider({
        apiKey: "anthropic-test",
        model: "claude-3-7-sonnet",
        fetchImpl,
        providerFallback: {
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          targets: [{ provider: "grok", model: "grok-4-fast" }],
          maxFailures: 5,
        },
      });

      const textChunks: string[] = [];
      const response = await provider.chatStream(
        [{ role: "user", content: "hello" }],
        (chunk) => {
          if (chunk.content) textChunks.push(chunk.content);
        },
      );

      // Exactly one fetch: the stream was NOT retried after partial output.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // The already-emitted chunk was not replayed/duplicated.
      expect(textChunks).toEqual(["partial"]);
      // A partial error response is surfaced rather than a silent retry.
      expect(response.content).toBe("partial");
      expect(response.finishReason).toBe("error");
      expect(response.partial).toBe(true);
      expect(response.error).toBeInstanceOf(Error);
    },
  );

  test(
    "still retries when a wait/overload error is thrown before any content",
    async () => {
      // First attempt errors immediately (no content emitted) -> retry occurs.
      // Second attempt succeeds.
      let attempt = 0;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
        attempt += 1;
        if (attempt === 1) {
          return Promise.resolve(
            sseResponseThenError([], new Error("overloaded_error")),
          );
        }
        return Promise.resolve(
          sseResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-3-7-sonnet","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recovered"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ]),
        );
      });

      vi.useFakeTimers();
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        const provider = new AnthropicProvider({
          apiKey: "anthropic-test",
          model: "claude-3-7-sonnet",
          fetchImpl,
          providerFallback: {
            provider: "anthropic",
            model: "claude-3-7-sonnet",
            targets: [{ provider: "grok", model: "grok-4-fast" }],
            maxFailures: 5,
          },
        });

        const textChunks: string[] = [];
        const pending = provider.chatStream(
          [{ role: "user", content: "hello" }],
          (chunk) => {
            if (chunk.content) textChunks.push(chunk.content);
          },
        );

        // Allow the fallback wait + retry to elapse.
        await vi.advanceTimersByTimeAsync(2000);
        const response = await pending;

        // Two fetches: the failed attempt and the successful retry.
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(textChunks).toEqual(["recovered"]);
        expect(response.content).toBe("recovered");
        expect(response.finishReason).toBe("stop");
        expect(response.partial).toBeFalsy();
      } finally {
        randomSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});
