import { describe, expect, test, vi } from "vitest";
import { AnthropicProvider } from "./adapter.js";

/**
 * Regression coverage for the streaming usage gaps in the Anthropic adapter:
 *
 *  1. The partial-failure return (outer catch, content already emitted) built
 *     `usage` by hand and only carried prompt/completion/total tokens, silently
 *     dropping the accumulated `cache_read_input_tokens`,
 *     `cache_creation_input_tokens`, `reasoning_output_tokens`, and
 *     `server_tool_use.web_search_requests`. Cache/billing telemetry vanished on
 *     any mid-stream failure that surfaced a partial response.
 *
 *  2. `mergeAnthropicUsage` retained the previous `input_tokens` whenever a later
 *     usage event reported `input_tokens: 0`, because the merge gated on
 *     `input_tokens > 0`. A provider that authoritatively reports zero input on a
 *     later event (e.g. a cached prefix counted entirely as cache_read) kept a
 *     stale nonzero count.
 *
 * The fix routes the partial usage through `coerceUsage` (so cache tokens carry
 * through) and treats any finite non-negative numeric `input_tokens` as
 * authoritative.
 */

/** An SSE response whose body emits `frames`, then errors the stream. */
function sseResponseThenError(frames: string[], error: Error): Response {
  const encoder = new TextEncoder();
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

describe("AnthropicProvider streaming usage (cache tokens + stale merge)", () => {
  test(
    "partial-failure response carries accumulated cache/reasoning/web-search " +
      "usage instead of dropping it",
    async () => {
      // message_start reports cache + reasoning + web-search usage. After a text
      // delta is forwarded, the transport errors -> a partial response surfaces.
      const MESSAGE_START =
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-3-7-sonnet","content":[],"usage":{"input_tokens":11,"output_tokens":3,"cache_read_input_tokens":7,"cache_creation_input_tokens":5,"reasoning_output_tokens":4,"server_tool_use":{"web_search_requests":2}}}}\n\n';

      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
        Promise.resolve(
          sseResponseThenError(
            [MESSAGE_START, TEXT_DELTA],
            new Error("network blip"),
          ),
        )
      );

      const provider = new AnthropicProvider({
        apiKey: "anthropic-test",
        model: "claude-3-7-sonnet",
        fetchImpl,
      });

      const response = await provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
      );

      expect(response.partial).toBe(true);
      expect(response.finishReason).toBe("error");
      expect(response.content).toBe("partial");
      // Core counts preserved.
      expect(response.usage.promptTokens).toBe(11);
      expect(response.usage.completionTokens).toBe(3);
      expect(response.usage.totalTokens).toBe(14);
      // Cache / reasoning / web-search telemetry must survive the partial path.
      expect(response.usage.cachedInputTokens).toBe(7);
      expect(response.usage.cacheCreationInputTokens).toBe(5);
      expect(response.usage.reasoningOutputTokens).toBe(4);
      expect(response.usage.webSearchRequests).toBe(2);
    },
  );

  test(
    "a later usage event reporting input_tokens: 0 overwrites the prior count " +
      "rather than retaining a stale value",
    async () => {
      // message_start reports input_tokens: 9, then message_delta authoritatively
      // reports input_tokens: 0. The final usage must reflect 0, not the stale 9.
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
        Promise.resolve(
          sseResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-3-7-sonnet","content":[],"usage":{"input_tokens":9,"output_tokens":0}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":0,"output_tokens":5}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ]),
        )
      );

      const provider = new AnthropicProvider({
        apiKey: "anthropic-test",
        model: "claude-3-7-sonnet",
        fetchImpl,
      });

      const response = await provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => {},
      );

      expect(response.partial).toBeFalsy();
      expect(response.finishReason).toBe("stop");
      // The zero from the later event is authoritative; the stale 9 is dropped.
      expect(response.usage.promptTokens).toBe(0);
      expect(response.usage.completionTokens).toBe(5);
    },
  );
});
