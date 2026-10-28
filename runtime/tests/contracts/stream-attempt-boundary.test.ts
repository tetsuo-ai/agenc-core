import { describe, expect, it } from "vitest";

import { isStreamAttemptDiscard } from "../../src/contracts/stream-attempt-boundary.js";
import {
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../../src/llm/errors.js";
import { StreamProgressError } from "../../src/llm/stream-progress.js";
import { StreamModelError } from "../../src/phases/stream-model.js";
import { streamRetryNoticeMessage } from "../../src/session/run-turn-stream-retry.js";

const MAX_ATTEMPTS = 6;

function errorEvent(
  payload: { readonly cause?: unknown; readonly message?: unknown } | unknown,
): { readonly type: string; readonly payload: unknown } {
  return { type: "stream_error", payload };
}

describe("isStreamAttemptDiscard", () => {
  it("treats an explicit discard cause as a discarded attempt, regardless of message", () => {
    expect(isStreamAttemptDiscard(errorEvent({
      cause: "stream_attempt_discarded",
      message: "The model stream was interrupted and automatic retries stopped.",
    }))).toBe(true);
    expect(isStreamAttemptDiscard(errorEvent({ cause: "stream_attempt_discarded" }))).toBe(true);
  });

  it.each([
    streamRetryNoticeMessage(new StreamProgressError("grok", "stream_loop"), 1, MAX_ATTEMPTS),
    streamRetryNoticeMessage(new StreamProgressError("grok", "stream_no_progress"), 1, MAX_ATTEMPTS),
    streamRetryNoticeMessage(
      new StreamModelError(new Error("stream_idle: no data for 600000ms")),
      1,
      MAX_ATTEMPTS,
    ),
    streamRetryNoticeMessage(
      new StreamModelError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })),
      1,
      MAX_ATTEMPTS,
    ),
    streamRetryNoticeMessage(new StreamModelError(new LLMRateLimitError("grok", 12_000)), 1, MAX_ATTEMPTS),
    streamRetryNoticeMessage(new StreamModelError(new LLMTimeoutError("grok", 120_000)), 1, MAX_ATTEMPTS),
    streamRetryNoticeMessage(new StreamModelError(new LLMServerError("grok", 503, "overloaded")), 1, MAX_ATTEMPTS),
    streamRetryNoticeMessage(new Error("something odd"), 1, MAX_ATTEMPTS),
    "connection lost (EPIPE), retrying in 2 s (3/6): broken pipe",
    "provider error, retrying in up to 1 s (2/6): provider stream cut",
  ])("recognizes a controlled reconnect notice as a discarded attempt: %s", (message) => {
    expect(isStreamAttemptDiscard(errorEvent({
      cause: "stream_disconnected",
      message,
    }))).toBe(true);
  });

  it.each([
    "The model stream was interrupted and automatic retries stopped. Type continue and press Enter to resume.",
    "The model stream disconnected; automatic retry stopped because streamed tool Write (call-1) reached running and may have executed. Type continue and press Enter to resume from the recorded tool results.",
    "The model stream disconnected; automatic retry stopped because provider error, retrying in up to 1 s (2/6): untrusted detail",
    "Idle watchdog fired.",
    "provider error (HTTP 503): overloaded, retrying in up to 1 s (2/6): wrapped in a provider body",
    "rate limited, server asked to wait 600 s, above the retry policy (2/6): grok rate limited, retry after 600000ms",
  ])("does not treat refusal, exhaustion, or embedded retry wording as a discard: %s", (message) => {
    expect(isStreamAttemptDiscard(errorEvent({
      cause: "stream_disconnected",
      message,
    }))).toBe(false);
  });

  it("ignores non-stream errors and malformed payloads", () => {
    expect(isStreamAttemptDiscard({ type: "agent_message_delta", payload: { delta: "hi" } })).toBe(false);
    expect(isStreamAttemptDiscard({ type: "stream_error" })).toBe(false);
    expect(isStreamAttemptDiscard(errorEvent("stream_attempt_discarded"))).toBe(false);
    expect(isStreamAttemptDiscard(errorEvent({
      cause: "stream_idle",
      message: "stream idle, retrying in up to 1 s (2/6): watchdog",
    }))).toBe(false);
    expect(isStreamAttemptDiscard(errorEvent({
      cause: "stream_disconnected",
      message: 12,
    }))).toBe(false);
  });
});
