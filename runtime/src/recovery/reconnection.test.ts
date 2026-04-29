import { describe, expect, test, vi } from "vitest";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import {
  computeBackoffMs,
  detectSuspend,
  RECONNECT_GIVE_UP_MS,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  RECONNECT_SLEEP_DETECTION_THRESHOLD_MS,
  reconnectWithBackoff,
} from "./reconnection.js";

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
    expect(RECONNECT_GIVE_UP_MS).toBe(600_000);
    expect(RECONNECT_SLEEP_DETECTION_THRESHOLD_MS).toBe(60_000);
  });
});
