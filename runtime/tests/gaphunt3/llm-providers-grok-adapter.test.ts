import { afterEach, describe, expect, test, vi } from "vitest";

import { GrokProvider } from "src/llm/providers/grok/adapter";
import { LLMProviderError } from "src/llm/errors";
import type { LLMStreamChunk } from "src/llm/types";

// gaphunt3 #21: grok chatStream must honor the caller's AbortSignal *after* the
// stream has opened. withTimeout only links options.signal until stream-open
// (its finally detaches the listener once fn resolves, which for a stream is at
// open), so the chunk loop must re-observe options.signal and tear the in-flight
// stream down promptly when the caller aborts. Before the fix the chunk loop
// blocked on iterator.next() with no abort wiring, so it could only settle once
// the per-chunk idle / total stream deadline timer fired — never on the caller's
// abort. The tests below use fake timers so NO timer can fire on its own; the
// only thing that can settle the promise is the abort path, making the test
// fail (hang -> test timeout) if the fix is reverted.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * A controllable xAI-style SSE stream. The first chunk resolves immediately;
 * every subsequent next() returns a promise that NEVER resolves on its own —
 * a real slow stream awaiting the next SSE frame. Records whether return()
 * (iterator teardown) was invoked, which the chunk loop's finally must call on
 * abort.
 */
function makeBlockingStream(
  firstEvent: Record<string, unknown>,
  closeResult: Promise<IteratorResult<Record<string, unknown>>> =
    Promise.resolve({ value: undefined, done: true }),
  settlePendingNextOnReturn = true,
): {
  stream: AsyncIterable<Record<string, unknown>>;
  returnCalled: () => boolean;
  pendingNextStarted: Promise<void>;
  settlePendingNext: () => void;
} {
  let yieldedFirst = false;
  let returnInvoked = false;
  let settlePendingNext: (() => void) | undefined;
  const pendingNextStarted = Promise.withResolvers<void>();
  const iterator: AsyncIterator<Record<string, unknown>> = {
    next(): Promise<IteratorResult<Record<string, unknown>>> {
      if (!yieldedFirst) {
        yieldedFirst = true;
        return Promise.resolve({ value: firstEvent, done: false });
      }
      pendingNextStarted.resolve();
      return new Promise<IteratorResult<Record<string, unknown>>>((resolve) => {
        settlePendingNext = () => resolve({ value: undefined, done: true });
      });
    },
    return(): Promise<IteratorResult<Record<string, unknown>>> {
      returnInvoked = true;
      if (settlePendingNextOnReturn) settlePendingNext?.();
      return closeResult;
    },
  };
  return {
    stream: { [Symbol.asyncIterator]: () => iterator },
    returnCalled: () => returnInvoked,
    pendingNextStarted: pendingNextStarted.promise,
    settlePendingNext: () => settlePendingNext?.(),
  };
}

function withResponse<T>(data: T) {
  return {
    withResponse: async () => ({
      data,
      response: new Response(null, { status: 200 }),
      request_id: null,
    }),
  };
}

/** Flush pending microtasks without advancing fake timers. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

describe("gaphunt3 #21: grok chatStream honors caller abort after stream open", () => {
  test("aborting options.signal mid-stream settles promptly and tears the stream down", async () => {
    vi.useFakeTimers();
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4.3",
      // Large stream deadline: under fake timers it is never advanced, so the
      // ONLY way this promise can settle is the abort path. Revert -> hang.
      timeoutMs: 10 * 60_000,
    });

    // First event carries no content so the catch branch throws (does not
    // return a partial result) and the rejection is observable.
    const { stream, returnCalled, pendingNextStarted } = makeBlockingStream({
      type: "response.reasoning_summary_text.delta",
      delta: "thinking...",
      summary_index: 0,
    });
    const create = vi.fn(() => withResponse(stream));
    (provider as any).client = { responses: { create } };

    const controller = new AbortController();
    const chunks: LLMStreamChunk[] = [];
    let settled: "rejected" | "resolved" | "pending" = "pending";
    let captured: unknown;
    void provider
      .chatStream(
        [{ role: "user", content: "go" }],
        (chunk) => chunks.push(chunk),
        { signal: controller.signal },
      )
      .then(
        () => {
          settled = "resolved";
        },
        (e) => {
          settled = "rejected";
          captured = e;
        },
      );

    // Let the stream open and consume the first (content-free) chunk; the loop
    // then parks on the blocking next(). Confirm it is still pending (no timer
    // advanced, no abort yet).
    await pendingNextStarted;
    expect(settled).toBe("pending");

    // Abort while parked. The abort path must settle the promise without any
    // timer firing.
    controller.abort();
    await flushMicrotasks();

    expect(settled).toBe("rejected");
    // Caller cancellation must not masquerade as a retryable provider timeout.
    expect(captured).toBeInstanceOf(LLMProviderError);
    // The in-flight stream iterator must be torn down on abort.
    expect(returnCalled()).toBe(true);
    // No visible content should have leaked from the aborted turn.
    expect(chunks.some((c) => c.content && c.content.length > 0)).toBe(false);
  });

  test("retains the model boundary until iterator teardown is confirmed", async () => {
    vi.useFakeTimers();
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4.3",
      timeoutMs: 10 * 60_000,
    });
    const closeGate = Promise.withResolvers<
      IteratorResult<Record<string, unknown>>
    >();
    const { stream, returnCalled, pendingNextStarted } = makeBlockingStream(
      {
        type: "response.reasoning_summary_text.delta",
        delta: "still thinking...",
        summary_index: 0,
      },
      closeGate.promise,
    );
    (provider as any).client = {
      responses: { create: vi.fn(() => withResponse(stream)) },
    };
    const controller = new AbortController();
    let settled: "rejected" | "resolved" | "pending" = "pending";

    void provider
      .chatStream([{ role: "user", content: "go" }], () => {}, {
        signal: controller.signal,
      })
      .then(
        () => {
          settled = "resolved";
        },
        () => {
          settled = "rejected";
        },
      );
    await pendingNextStarted;
    controller.abort();
    await flushMicrotasks();

    expect(returnCalled()).toBe(true);
    expect(settled).toBe("pending");

    closeGate.resolve({ value: undefined, done: true });
    await flushMicrotasks();
    expect(settled).toBe("rejected");
  });

  test("does not trust return resolution while a pending next remains live", async () => {
    vi.useFakeTimers();
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4.3",
      timeoutMs: 10 * 60_000,
    });
    const {
      stream,
      returnCalled,
      pendingNextStarted,
      settlePendingNext,
    } = makeBlockingStream(
      {
        type: "response.reasoning_summary_text.delta",
        delta: "abort-ignoring read",
        summary_index: 0,
      },
      Promise.resolve({ value: undefined, done: true }),
      false,
    );
    (provider as any).client = {
      responses: { create: vi.fn(() => withResponse(stream)) },
    };
    const controller = new AbortController();
    let settled: "rejected" | "resolved" | "pending" = "pending";

    void provider
      .chatStream([{ role: "user", content: "go" }], () => {}, {
        signal: controller.signal,
      })
      .then(
        () => {
          settled = "resolved";
        },
        () => {
          settled = "rejected";
        },
      );
    await pendingNextStarted;
    controller.abort();
    await flushMicrotasks();

    expect(returnCalled()).toBe(true);
    expect(settled).toBe("pending");

    settlePendingNext();
    await flushMicrotasks();
    expect(settled).toBe("rejected");
  });

  test("the loop re-checks options.signal before awaiting each chunk", async () => {
    // Same scenario but the signal is aborted just after the loop parks on the
    // second next(); the loop-top guard / chunk-await abort listener must fire.
    // Under fake timers no idle/deadline timer can settle this, so a reverted
    // fix leaves the promise pending (test hang -> failure).
    vi.useFakeTimers();
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4.3",
      timeoutMs: 10 * 60_000,
    });

    const { stream, returnCalled, pendingNextStarted } = makeBlockingStream({
      type: "response.reasoning_summary_text.delta",
      delta: "more thinking...",
      summary_index: 0,
    });
    const create = vi.fn(() => withResponse(stream));
    (provider as any).client = { responses: { create } };

    const controller = new AbortController();
    let settled: "rejected" | "resolved" | "pending" = "pending";
    let captured: unknown;
    void provider
      .chatStream([{ role: "user", content: "go" }], () => {}, {
        signal: controller.signal,
      })
      .then(
        () => {
          settled = "resolved";
        },
        (e) => {
          settled = "rejected";
          captured = e;
        },
      );

    await pendingNextStarted;
    expect(settled).toBe("pending");
    controller.abort();
    await flushMicrotasks();

    expect(settled).toBe("rejected");
    expect(captured).toBeInstanceOf(LLMProviderError);
    expect(returnCalled()).toBe(true);
  });
});
