import { describe, expect, test, vi } from "vitest";
import type { LLMStreamChunk } from "../../types.js";
import { AnthropicProvider } from "./adapter.js";
import {
  createAnthropicFallbackProvider,
  sseResponse,
  sseResponseThenError,
  withDeterministicFallbackTimers,
} from "./stream-test-helpers.js";

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
const TEXT_START =
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n';
const TEXT_DELTA =
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"partial"}}\n\n';
const TEXT_STOP =
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n';
const TOOL_START =
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}\n\n';
const IN_STREAM_OVERLOAD =
  'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n';
const RETRY_THINK_DELTA =
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"RETRY-THINK"}}\n\n';
const RECOVERED_TEXT_DELTA =
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"recovered"}}\n\n';
const MESSAGE_DELTA =
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n';
const MESSAGE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const AFTER_START = [MESSAGE_START, THINKING_START] as const;
const AFTER_DELTA = [...AFTER_START, THINKING_DELTA] as const;
const AFTER_SIGNATURE = [...AFTER_DELTA, THINKING_SIGNATURE] as const;
const AFTER_STOP = [...AFTER_SIGNATURE, THINKING_STOP] as const;

const THINKING_PHASES = [
  { name: "start", frames: AFTER_START, expectedThinkingText: "" },
  { name: "delta", frames: AFTER_DELTA, expectedThinkingText: "Let me " },
  {
    name: "signature",
    frames: AFTER_SIGNATURE,
    expectedThinkingText: "Let me ",
  },
  { name: "stop", frames: AFTER_STOP, expectedThinkingText: "Let me " },
  {
    name: "text",
    frames: [...AFTER_START, THINKING_DELTA, THINKING_STOP, TEXT_DELTA],
    expectedThinkingText: "Let me ",
  },
  {
    name: "tool",
    frames: [...AFTER_START, THINKING_DELTA, THINKING_STOP, TOOL_START],
    expectedThinkingText: "Let me ",
  },
] as const;

type OverloadKind = "in-stream" | "transport";

const RETRY_SUCCESS_FRAMES = [
  MESSAGE_START,
  THINKING_START,
  RETRY_THINK_DELTA,
  THINKING_STOP,
  TEXT_START,
  RECOVERED_TEXT_DELTA,
  TEXT_STOP,
  MESSAGE_DELTA,
  MESSAGE_STOP,
];

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

function firstAttemptResponse(
  frames: readonly string[],
  kind: OverloadKind,
): Response {
  switch (kind) {
    case "in-stream":
      return sseResponse([...frames, IN_STREAM_OVERLOAD]);
    case "transport":
      return sseResponseThenError([...frames], new Error("overloaded_error"));
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
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

async function streamWithFallbackRetry(
  firstResponse: Response,
): Promise<{
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  chunks: LLMStreamChunk[];
  response: Awaited<ReturnType<AnthropicProvider["chatStream"]>>;
}> {
  const fetchImpl = fetchThatRetriesOnSuccess(firstResponse);
  const chunks: LLMStreamChunk[] = [];
  const pending = createAnthropicFallbackProvider(fetchImpl).chatStream(
    [{ role: "user", content: "think" }],
    (chunk) => {
      chunks.push(chunk);
    },
  );
  await vi.advanceTimersByTimeAsync(2000);
  return { fetchImpl, chunks, response: await pending };
}

function expectClosedThinkingAttempt(
  chunks: readonly LLMStreamChunk[],
  expectedThinkingText: string,
): void {
  expect(streamedThinkingText(chunks)).toBe(expectedThinkingText);
  expect(streamedThinkingText(chunks)).not.toContain("RETRY-THINK");
  expect(thinkingStarts(chunks)).toEqual(thinkingStops(chunks));
  expect(thinkingStarts(chunks).length).toBeGreaterThan(0);
  expect(chunks.some((chunk) => chunk.content === "recovered")).toBe(false);
}

describe("AnthropicProvider thinking-stream fallback retry (#2107)", () => {
  test.each(
    THINKING_PHASES.flatMap((phase) =>
      (["in-stream", "transport"] as const).map((kind) => ({
        ...phase,
        kind,
        expectSignature:
          kind === "in-stream" &&
          (phase.name === "signature" || phase.name === "stop"),
      })),
    ),
  )(
    "$kind overload after thinking $name does not silently restart",
    async ({ frames, expectedThinkingText, name, kind, expectSignature }) => {
      await withDeterministicFallbackTimers(async () => {
        const { fetchImpl, chunks, response } = await streamWithFallbackRetry(
          firstAttemptResponse(frames, kind),
        );

        expect(
          fetchImpl,
          `retried after thinking ${name}`,
        ).toHaveBeenCalledTimes(1);
        expectClosedThinkingAttempt(chunks, expectedThinkingText);
        expect(response.partial).toBe(true);
        expect(response.finishReason).toBe("error");
        expect(response.content).toBe(name === "text" ? "partial" : "");
        expect(response.thinking).toEqual([
          expect.objectContaining({
            text: expectedThinkingText,
            redacted: false,
            ...(expectSignature ? { signature: "ABCDEF==" } : {}),
          }),
        ]);
      });
    },
  );

  test("pre-output overload still retries and does not invent thinking events", async () => {
    await withDeterministicFallbackTimers(async () => {
      const { fetchImpl, chunks, response } = await streamWithFallbackRetry(
        sseResponse([MESSAGE_START, IN_STREAM_OVERLOAD]),
      );

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
