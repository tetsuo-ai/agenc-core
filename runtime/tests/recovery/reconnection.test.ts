import { describe, expect, test, vi } from "vitest";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import {
  computeBackoffMs,
  detectSuspend,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  RECONNECT_RETRY_AFTER_CEILING_MS,
  RECONNECT_SLEEP_DETECTION_THRESHOLD_MS,
  reconnectWithBackoff,
  serverDirectedRetryAfterMs,
} from "./reconnection.js";
import { LLMRateLimitError } from "../llm/errors.js";

function mkSession(log: EventLog): Session {
  let i = 0;
  return {
    eventLog: log,
    nextInternalSubId: () => `s-${++i}`,
  } as unknown as Session;
}

describe("computeBackoffMs", () => {
  test("grows exponentially, capped at RECONNECT_MAX_MS", () => {
    expect(computeBackoffMs(0)).toBeGreaterThanOrEqual(RECONNECT_INITIAL_MS * 0.7);
    expect(computeBackoffMs(0)).toBeLessThanOrEqual(RECONNECT_INITIAL_MS * 1.3);
    const large = computeBackoffMs(20);
    expect(large).toBeLessThanOrEqual(RECONNECT_MAX_MS * 1.3);
  });

  test("honors a server-directed Retry-After over the 2^attempt backoff", () => {
    // attempt 0 backoff is ~1s, far below the 5s server directive — the
    // server cooldown must win so we don't hammer during its window.
    expect(computeBackoffMs(0, 5_000)).toBeGreaterThanOrEqual(5_000);
  });

  test("uses the larger of computed backoff and Retry-After", () => {
    // A tiny Retry-After must not shrink the normal escalating backoff.
    const computed = computeBackoffMs(20, 1);
    expect(computed).toBeGreaterThanOrEqual(RECONNECT_MAX_MS * 0.7);
  });

  test("no Retry-After leaves the normal path unchanged", () => {
    expect(computeBackoffMs(0, undefined)).toBeLessThanOrEqual(
      RECONNECT_INITIAL_MS * 1.3,
    );
  });
});

describe("serverDirectedRetryAfterMs", () => {
  test("reads retryAfterMs off an LLMRateLimitError (429)", () => {
    const err = new LLMRateLimitError("grok", 5_000);
    expect(serverDirectedRetryAfterMs(err)).toBe(5_000);
  });

  test("reads retryAfterMs off a wrapped (cause-chain) error", () => {
    const wrapped = new Error("stream disconnected");
    (wrapped as { cause?: unknown }).cause = new LLMRateLimitError(
      "grok",
      7_000,
    );
    expect(serverDirectedRetryAfterMs(wrapped)).toBe(7_000);
  });

  test("clamps a pathological Retry-After to the ceiling", () => {
    const err = new LLMRateLimitError("grok", 60 * 60 * 1_000);
    expect(serverDirectedRetryAfterMs(err)).toBe(
      RECONNECT_RETRY_AFTER_CEILING_MS,
    );
  });

  test("returns undefined when no server directive is present", () => {
    expect(serverDirectedRetryAfterMs(new Error("ECONNRESET"))).toBeUndefined();
    expect(serverDirectedRetryAfterMs(new LLMRateLimitError("grok"))).toBeUndefined();
  });
});

describe("reconnectWithBackoff", () => {
  test("success on first try", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const out = await reconnectWithBackoff({
      session,
      attempt: async () => "ok",
      isTransient: () => true,
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.value).toBe("ok");
  });

  test("retries transient, eventually succeeds", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    let calls = 0;
    const out = await reconnectWithBackoff({
      session,
      maxAttempts: 3,
      attempt: async () => {
        calls += 1;
        if (calls < 2) throw new Error("ECONNRESET");
        return "got-it";
      },
      isTransient: () => true,
    });
    expect(out.kind).toBe("ok");
    expect(calls).toBe(2);
  });

  test("exhausted after maxAttempts transient errors", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const out = await reconnectWithBackoff({
      session,
      maxAttempts: 2,
      attempt: async () => {
        throw new Error("stream_idle");
      },
      isTransient: () => true,
    });
    expect(out.kind).toBe("exhausted");
  });

  test("stops retrying when the recovery-cap hook rejects another re-entry", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const gate = vi.fn().mockResolvedValue(false);

    const out = await reconnectWithBackoff({
      session,
      attempt: async () => {
        throw new Error("stream_idle");
      },
      isTransient: () => true,
      onTransientRetry: gate,
    });

    expect(out.kind).toBe("exhausted");
    expect(gate).toHaveBeenCalledTimes(1);
  });

  test("exhausts once the reconnect give-up budget elapses", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const out = await reconnectWithBackoff({
      session,
      now: () => 0,
      giveUpMs: 0,
      attempt: async () => {
        throw new Error("stream_idle");
      },
      isTransient: () => true,
    });

    expect(out.kind).toBe("exhausted");
    if (out.kind === "exhausted") {
      expect(out.attempts).toBe(1);
    }
  });

  test("has no implicit give-up deadline after six hours", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const log = new EventLog();
      const session = mkSession(log);
      let now = 0;
      let calls = 0;
      const promise = reconnectWithBackoff({
        session,
        now: () => now,
        sleepDetectionThresholdMs: Number.POSITIVE_INFINITY,
        maxAttempts: 3,
        attempt: async () => {
          calls += 1;
          if (calls < 3) throw new Error("stream_idle");
          return "recovered";
        },
        isTransient: () => true,
      });

      await Promise.resolve();
      now = 6 * 60 * 60_000;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(promise).resolves.toMatchObject({
        kind: "ok",
        value: "recovered",
      });
      expect(calls).toBe(3);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test("non-transient error bubbles immediately", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    await expect(
      reconnectWithBackoff({
        session,
        attempt: async () => {
          throw new Error("401 unauthorized");
        },
        isTransient: () => false,
      }),
    ).rejects.toThrow("401");
  });

  test("aborted signal short-circuits", async () => {
    const log = new EventLog();
    const session = mkSession(log);
    const ctl = new AbortController();
    ctl.abort("test");
    const out = await reconnectWithBackoff({
      session,
      signal: ctl.signal,
      attempt: async () => "x",
      isTransient: () => true,
    });
    expect(out.kind).toBe("aborted");
  });

  test("resets the reconnect budget after a long suspend gap", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const log = new EventLog();
    const session = mkSession(log);
    let now = 0;
    let calls = 0;

    const promise = reconnectWithBackoff({
      session,
      now: () => now,
      giveUpMs: 1_500,
      sleepDetectionThresholdMs: 60_000,
      attempt: async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("stream_idle");
        }
        return "recovered";
      },
      isTransient: () => true,
    });

    await Promise.resolve();
    now = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    now = 120_000;
    await vi.advanceTimersByTimeAsync(2_000);

    const out = await promise;
    expect(out.kind).toBe("ok");
    expect(calls).toBe(3);
    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  test("honors a 429 Retry-After: sleeps >= 5000ms before the next attempt", async () => {
    vi.useFakeTimers();
    // Pin jitter to 0 so the local attempt-0 backoff is exactly
    // RECONNECT_INITIAL_MS (1000ms) — far below the 5000ms the provider
    // directs. Without the fix the retry fires at ~1000ms; with the fix it
    // must wait for the full 5000ms Retry-After window.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const log = new EventLog();
    const session = mkSession(log);
    let calls = 0;
    let resolved = false;

    const promise = reconnectWithBackoff({
      session,
      attempt: async () => {
        calls += 1;
        if (calls < 2) {
          // grok's default 429 maps to LLMRateLimitError carrying the
          // server-directed cooldown (5s here).
          throw new LLMRateLimitError("grok", 5_000);
        }
        return "recovered";
      },
      isTransient: () => true,
    }).then((out) => {
      resolved = true;
      return out;
    });

    // Let the first attempt run and enter the backoff sleep.
    await Promise.resolve();
    expect(calls).toBe(1);

    // At 4999ms the server cooldown has NOT elapsed: the second attempt
    // must not have fired yet. (Pre-fix this would already be the 2nd call
    // because the sleep was only ~1000ms.)
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(1);
    expect(resolved).toBe(false);

    // Crossing 5000ms total releases the sleep and the retry succeeds.
    await vi.advanceTimersByTimeAsync(2);
    const out = await promise;

    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.value).toBe("recovered");
    expect(calls).toBe(2);

    randomSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe("detectSuspend", () => {
  test("gap < 60s → not suspended", () => {
    const now = performance.now();
    const d = detectSuspend(now - 10_000);
    expect(d.suspended).toBe(false);
  });
  test("gap > sleep threshold → suspended", () => {
    const now = performance.now();
    const d = detectSuspend(
      now - (RECONNECT_SLEEP_DETECTION_THRESHOLD_MS + 1_000),
    );
    expect(d.suspended).toBe(true);
  });

  test("defaults match the transport reconnection contract", () => {
    expect(RECONNECT_INITIAL_MS).toBe(1_000);
    expect(RECONNECT_MAX_MS).toBe(30_000);
    expect(RECONNECT_SLEEP_DETECTION_THRESHOLD_MS).toBe(60_000);
  });
});
