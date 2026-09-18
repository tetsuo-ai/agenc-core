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

type ThinkingPhase =
  | "start"
  | "delta"
  | "signature"
  | "stop"
  | "text"
  | "tool";
type OverloadKind = "in-stream" | "transport";

const THINKING_PHASES = [
  "start",
  "delta",
  "signature",
  "stop",
  "text",
  "tool",
] as const;
const OVERLOAD_KINDS = ["in-stream", "transport"] as const;

function sseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

function messageStartFrame(): string {
  return sseFrame("message_start", {
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3-7-sonnet",
      content: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
}

function framesThrough(phase: ThinkingPhase): string[] {
  const opened = [
    messageStartFrame(),
    sseFrame("content_block_start", {
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
  ];
  if (phase === "start") return opened;
  const withDelta = [
    ...opened,
    sseFrame("content_block_delta", {
      index: 0,
      delta: { type: "thinking_delta", thinking: "Let me " },
    }),
  ];
  switch (phase) {
    case "delta":
      return withDelta;
    case "signature":
      return [
        ...withDelta,
        sseFrame("content_block_delta", {
          index: 0,
          delta: { type: "signature_delta", signature: "ABCDEF==" },
        }),
      ];
    case "stop":
      return [
        ...withDelta,
        sseFrame("content_block_delta", {
          index: 0,
          delta: { type: "signature_delta", signature: "ABCDEF==" },
        }),
        sseFrame("content_block_stop", { index: 0 }),
      ];
    case "text":
      return [
        ...withDelta,
        sseFrame("content_block_stop", { index: 0 }),
        sseFrame("content_block_delta", {
          index: 1,
          delta: { type: "text_delta", text: "partial" },
        }),
      ];
    case "tool":
      return [
        ...withDelta,
        sseFrame("content_block_stop", { index: 0 }),
        sseFrame("content_block_start", {
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
        }),
      ];
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

function retrySuccessFrames(): string[] {
  return [
    messageStartFrame(),
    sseFrame("content_block_start", {
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    sseFrame("content_block_delta", {
      index: 0,
      delta: { type: "thinking_delta", thinking: "RETRY-THINK" },
    }),
    sseFrame("content_block_stop", { index: 0 }),
    sseFrame("content_block_start", {
      index: 1,
      content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
      index: 1,
      delta: { type: "text_delta", text: "recovered" },
    }),
    sseFrame("content_block_stop", { index: 1 }),
    sseFrame("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    }),
    sseFrame("message_stop", {}),
  ];
}

function inStreamOverloadFrame(): string {
  return sseFrame("error", {
    error: { type: "overloaded_error", message: "busy" },
  });
}

function thinkingIndexes(
  chunks: readonly LLMStreamChunk[],
  edge: "start" | "stop",
): number[] {
  return chunks.flatMap((chunk) => {
    if (edge === "start") {
      return chunk.thinkingBlockStart ? [chunk.thinkingBlockStart.index] : [];
    }
    return chunk.thinkingBlockStop ? [chunk.thinkingBlockStop.index] : [];
  });
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
      return sseResponse([...frames, inStreamOverloadFrame()]);
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
    return Promise.resolve(
      attempt === 1 ? firstResponse : sseResponse(retrySuccessFrames()),
    );
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

describe("AnthropicProvider thinking-stream fallback retry (#2107)", () => {
  test.each(
    THINKING_PHASES.flatMap((phase) =>
      OVERLOAD_KINDS.map((kind) => ({ phase, kind })),
    ),
  )(
    "$kind overload after thinking $phase does not silently restart",
    async ({ phase, kind }) => {
      await withDeterministicFallbackTimers(async () => {
        const expectedThinkingText = phase === "start" ? "" : "Let me ";
        const { fetchImpl, chunks, response } = await streamWithFallbackRetry(
          firstAttemptResponse(framesThrough(phase), kind),
        );
        const expectSignature =
          kind === "in-stream" &&
          (phase === "signature" || phase === "stop");

        expect(
          fetchImpl,
          `retried after thinking ${phase}`,
        ).toHaveBeenCalledTimes(1);
        expect(streamedThinkingText(chunks)).toBe(expectedThinkingText);
        expect(streamedThinkingText(chunks)).not.toContain("RETRY-THINK");
        expect(thinkingIndexes(chunks, "start")).toEqual(
          thinkingIndexes(chunks, "stop"),
        );
        expect(thinkingIndexes(chunks, "start").length).toBeGreaterThan(0);
        expect(chunks.some((chunk) => chunk.content === "recovered")).toBe(
          false,
        );
        expect(response.partial).toBe(true);
        expect(response.finishReason).toBe("error");
        expect(response.content).toBe(phase === "text" ? "partial" : "");
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
        sseResponse([messageStartFrame(), inStreamOverloadFrame()]),
      );

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(streamedThinkingText(chunks)).toBe("RETRY-THINK");
      expect(thinkingIndexes(chunks, "start")).toEqual(
        thinkingIndexes(chunks, "stop"),
      );
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
