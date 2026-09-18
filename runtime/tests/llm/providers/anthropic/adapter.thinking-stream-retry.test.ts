import { describe, expect, test, vi } from "vitest";
import type { LLMStreamChunk } from "../../types.js";
import { AnthropicProvider } from "./adapter.js";

/**
 * Regression coverage for #2107: Anthropic streaming fallback retries used
 * to ignore thinking starts/deltas/completed blocks. A retryable error after
 * thinking had already been forwarded replayed the thinking stream, leaving
 * unbalanced start/stop events and a persisted response from a different
 * attempt than the one the consumer rendered.
 *
 * The adapter must fail closed after the first model-visible event: no
 * silent restart, balanced thinking blocks, and the returned partial
 * response describing the same attempt that was streamed.
 */

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

/** Frames first, then a transport error on the next pull. */
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

function useDeterministicFallbackTimers(): () => void {
  vi.useFakeTimers();
  const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
  return () => {
    randomSpy.mockRestore();
    vi.useRealTimers();
  };
}

const MESSAGE_START =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-3-7-sonnet","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
const THINKING_START =
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n';
const THINKING_DELTA =
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me "}}\n\n';
const THINKING_SIGNATURE =
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"ABCDEF=="}}\n\n';
const THINKING_STOP =
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
const TEXT_DELTA =
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"partial"}}\n\n';
const TOOL_START =
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}\n\n';
const IN_STREAM_OVERLOAD =
  'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n';

const RETRY_SUCCESS_FRAMES = [
  MESSAGE_START,
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"RETRY-THINK"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"recovered"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function createProvider(fetchImpl: typeof fetch): AnthropicProvider {
  return new AnthropicProvider({
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
}

function thinkingStarts(chunks: readonly LLMStreamChunk[]): number[] {
  return chunks.flatMap((chunk) =>
    chunk.thinkingBlockStart ? [chunk.thinkingBlockStart.index] : [],
  );
}

function thinkingStops(chunks: readonly LLMStreamChunk[]): number[] {
  return chunks.flatMap((chunk) =>
    chunk.thinkingBlockStop ? [chunk.thinkingBlockStop.index] : [],
  );
}

function streamedThinkingText(chunks: readonly LLMStreamChunk[]): string {
  return chunks
    .flatMap((chunk) => (chunk.thinkingDelta ? [chunk.thinkingDelta.delta] : []))
    .join("");
}

function fetchThatRetriesOnSuccess(
  firstResponse: Response,
): ReturnType<typeof vi.fn<typeof fetch>> {
  let attempt = 0;
  return vi.fn<typeof fetch>().mockImplementation(() => {
    attempt += 1;
    if (attempt === 1) {
      return Promise.resolve(firstResponse);
    }
    return Promise.resolve(sseResponse(RETRY_SUCCESS_FRAMES));
  });
}

async function runWithFallbackTimers(
  work: () => Promise<void>,
): Promise<void> {
  const restoreTimers = useDeterministicFallbackTimers();
  try {
    await work();
  } finally {
    restoreTimers();
  }
}

describe("AnthropicProvider thinking-stream fallback retry (#2107)", () => {
  test.each([
    {
      name: "start",
      frames: [MESSAGE_START, THINKING_START],
      expectedThinkingText: "",
    },
    {
      name: "delta",
      frames: [MESSAGE_START, THINKING_START, THINKING_DELTA],
      expectedThinkingText: "Let me ",
    },
    {
      name: "signature",
      frames: [
        MESSAGE_START,
        THINKING_START,
        THINKING_DELTA,
        THINKING_SIGNATURE,
      ],
      expectedThinkingText: "Let me ",
    },
    {
      name: "stop",
      frames: [
        MESSAGE_START,
        THINKING_START,
        THINKING_DELTA,
        THINKING_SIGNATURE,
        THINKING_STOP,
      ],
      expectedThinkingText: "Let me ",
    },
    {
      name: "text",
      frames: [
        MESSAGE_START,
        THINKING_START,
        THINKING_DELTA,
        THINKING_STOP,
        TEXT_DELTA,
      ],
      expectedThinkingText: "Let me ",
    },
    {
      name: "tool",
      frames: [
        MESSAGE_START,
        THINKING_START,
        THINKING_DELTA,
        THINKING_STOP,
        TOOL_START,
      ],
      expectedThinkingText: "Let me ",
    },
  ] as const)(
    "in-stream overload after thinking $name does not silently restart",
    async ({ frames, expectedThinkingText, name }) => {
      await runWithFallbackTimers(async () => {
        const fetchImpl = fetchThatRetriesOnSuccess(
          sseResponse([...frames, IN_STREAM_OVERLOAD]),
        );
        const provider = createProvider(fetchImpl);
        const chunks: LLMStreamChunk[] = [];
        const pending = provider.chatStream(
          [{ role: "user", content: "think" }],
          (chunk) => {
            chunks.push(chunk);
          },
        );
        await vi.advanceTimersByTimeAsync(2000);
        const response = await pending;

        expect(fetchImpl, `retried after thinking ${name}`).toHaveBeenCalledTimes(
          1,
        );
        expect(streamedThinkingText(chunks)).toBe(expectedThinkingText);
        expect(streamedThinkingText(chunks)).not.toContain("RETRY-THINK");
        expect(thinkingStarts(chunks)).toEqual(thinkingStops(chunks));
        expect(thinkingStarts(chunks).length).toBeGreaterThan(0);
        expect(response.partial).toBe(true);
        expect(response.finishReason).toBe("error");
        expect(response.content).toBe(name === "text" ? "partial" : "");
        expect(response.thinking).toEqual([
          expect.objectContaining({
            text: expectedThinkingText,
            redacted: false,
            ...(name === "signature" || name === "stop"
              ? { signature: "ABCDEF==" }
              : {}),
          }),
        ]);
        expect(chunks.some((chunk) => chunk.content === "recovered")).toBe(
          false,
        );
      });
    },
  );

  test.each([
    {
      name: "start",
      frames: [MESSAGE_START, THINKING_START],
      expectedThinkingText: "",
    },
    {
      name: "delta",
      frames: [MESSAGE_START, THINKING_START, THINKING_DELTA],
      expectedThinkingText: "Let me ",
    },
    {
      name: "signature",
      frames: [
        MESSAGE_START,
        THINKING_START,
        THINKING_DELTA,
        THINKING_SIGNATURE,
      ],
      expectedThinkingText: "Let me ",
    },
    {
      name: "stop",
      frames: [
        MESSAGE_START,
        THINKING_START,
        THINKING_DELTA,
        THINKING_SIGNATURE,
        THINKING_STOP,
      ],
      expectedThinkingText: "Let me ",
    },
    {
      name: "text",
      frames: [
        MESSAGE_START,
        THINKING_START,
        THINKING_DELTA,
        THINKING_STOP,
        TEXT_DELTA,
      ],
      expectedThinkingText: "Let me ",
    },
    {
      name: "tool",
      frames: [
        MESSAGE_START,
        THINKING_START,
        THINKING_DELTA,
        THINKING_STOP,
        TOOL_START,
      ],
      expectedThinkingText: "Let me ",
    },
  ] as const)(
    "transport overload after thinking $name does not silently restart",
    async ({ frames, expectedThinkingText, name }) => {
      await runWithFallbackTimers(async () => {
        const fetchImpl = fetchThatRetriesOnSuccess(
          sseResponseThenError([...frames], new Error("overloaded_error")),
        );
        const provider = createProvider(fetchImpl);
        const chunks: LLMStreamChunk[] = [];
        const pending = provider.chatStream(
          [{ role: "user", content: "think" }],
          (chunk) => {
            chunks.push(chunk);
          },
        );
        await vi.advanceTimersByTimeAsync(2000);
        const response = await pending;

        expect(fetchImpl, `retried after thinking ${name}`).toHaveBeenCalledTimes(
          1,
        );
        expect(streamedThinkingText(chunks)).toBe(expectedThinkingText);
        expect(streamedThinkingText(chunks)).not.toContain("RETRY-THINK");
        expect(thinkingStarts(chunks)).toEqual(thinkingStops(chunks));
        expect(thinkingStarts(chunks).length).toBeGreaterThan(0);
        expect(response.partial).toBe(true);
        expect(response.finishReason).toBe("error");
        expect(response.content).toBe(name === "text" ? "partial" : "");
        expect(response.thinking).toEqual([
          expect.objectContaining({
            text: expectedThinkingText,
            redacted: false,
          }),
        ]);
      });
    },
  );

  test("pre-output overload still retries and does not invent thinking events", async () => {
    await runWithFallbackTimers(async () => {
      const fetchImpl = fetchThatRetriesOnSuccess(
        sseResponse([MESSAGE_START, IN_STREAM_OVERLOAD]),
      );
      const provider = createProvider(fetchImpl);
      const chunks: LLMStreamChunk[] = [];
      const pending = provider.chatStream(
        [{ role: "user", content: "think" }],
        (chunk) => {
          chunks.push(chunk);
        },
      );
      await vi.advanceTimersByTimeAsync(2000);
      const response = await pending;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(streamedThinkingText(chunks)).toBe("RETRY-THINK");
      expect(thinkingStarts(chunks)).toEqual(thinkingStops(chunks));
      expect(response.content).toBe("recovered");
      expect(response.finishReason).toBe("stop");
      expect(response.partial).toBeFalsy();
      expect(response.thinking?.[0]).toMatchObject({
        text: "RETRY-THINK",
        redacted: false,
      });
    });
  });
});
