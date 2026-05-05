import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  STREAM_IDLE_ABORT_REASON,
  STREAM_IDLE_WARNING_REASON,
  installStreamWatchdog,
} from "../stream-watchdog.js";

describe("llm api watchdog", () => {
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 0;
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("uses the shared stream watchdog implementation", () => {
    const abortController = new AbortController();
    const warnings: Array<{ elapsedMs: number; reason: string }> = [];
    const fired: Array<{ elapsedMs: number; reason: string }> = [];

    const handle = installStreamWatchdog({
      abortController,
      timeoutMs: 100,
      onWarning: (info) => warnings.push(info),
      onFired: (info) => fired.push(info),
    });

    nowMs = 50;
    vi.advanceTimersByTime(50);
    expect(warnings).toEqual([
      { elapsedMs: 50, reason: STREAM_IDLE_WARNING_REASON },
    ]);

    nowMs = 100;
    vi.advanceTimersByTime(50);
    expect(fired).toEqual([
      { elapsedMs: 100, reason: STREAM_IDLE_ABORT_REASON },
    ]);
    expect(abortController.signal.reason).toBe(STREAM_IDLE_ABORT_REASON);
    expect(handle.firedAt).toBe(100);
  });
});
