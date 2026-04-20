import { describe, expect, test } from "vitest";
import { EventLog } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import {
  computeBackoffMs,
  detectSuspend,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_MS,
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

  test("max attempts default matches RECONNECT_MAX_ATTEMPTS", () => {
    expect(RECONNECT_MAX_ATTEMPTS).toBe(5);
  });
});

describe("detectSuspend", () => {
  test("gap < 60s → not suspended", () => {
    const now = performance.now();
    const d = detectSuspend(now - 10_000);
    expect(d.suspended).toBe(false);
  });
  test("gap > 60s → suspended", () => {
    const now = performance.now();
    const d = detectSuspend(now - 120_000);
    expect(d.suspended).toBe(true);
  });
});
