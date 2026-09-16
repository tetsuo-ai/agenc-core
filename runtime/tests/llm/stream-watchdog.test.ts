import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  classifyStreamLiveness,
  formatStreamQuietWarning,
  installStreamWatchdog,
  STREAM_IDLE_ABORT_REASON,
  STREAM_IDLE_WARNING_REASON,
  streamChunkHasDelta,
} from "./stream-watchdog.js";

describe("stream-watchdog", () => {
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

  test("installs no deadline by default, even after six hours", () => {
    const abortController = new AbortController();
    const onFired = vi.fn();
    const handle = installStreamWatchdog({ abortController, onFired });

    nowMs = 6 * 60 * 60_000;
    vi.advanceTimersByTime(nowMs);

    expect(handle.timeoutMs).toBe(0);
    expect(onFired).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(false);
  });

  test("emits a half-time warning before the monotonic timeout abort", () => {
    const abortController = new AbortController();
    const warnings: Array<{ elapsedMs: number; reason: string }> = [];
    const fired: Array<{ elapsedMs: number; reason: string }> = [];

    const handle = installStreamWatchdog({
      abortController,
      timeoutMs: 100,
      onWarning: (info) => warnings.push(info),
      onFired: (info) => fired.push(info),
    });

    nowMs = 49;
    vi.advanceTimersByTime(49);
    expect(warnings).toEqual([]);
    expect(fired).toEqual([]);

    nowMs = 50;
    vi.advanceTimersByTime(1);
    expect(warnings).toEqual([
      { elapsedMs: 50, reason: STREAM_IDLE_WARNING_REASON },
    ]);
    expect(abortController.signal.aborted).toBe(false);

    nowMs = 100;
    vi.advanceTimersByTime(50);
    expect(fired).toEqual([
      { elapsedMs: 100, reason: STREAM_IDLE_ABORT_REASON },
    ]);
    expect(abortController.signal.reason).toBe(STREAM_IDLE_ABORT_REASON);
    expect(handle.firedAt).toBe(100);
  });

  test("a delta kick resets the quiet warning window without aborting", () => {
    const abortController = new AbortController();
    const warnings: Array<{ elapsedMs: number; reason: string }> = [];
    const fired: Array<{ elapsedMs: number; reason: string }> = [];
    const handle = installStreamWatchdog({
      abortController,
      timeoutMs: 100,
      onWarning: (info) => warnings.push(info),
      onFired: (info) => fired.push(info),
    });

    nowMs = 40;
    vi.advanceTimersByTime(40);
    handle.kick();

    nowMs = 89;
    vi.advanceTimersByTime(49);
    expect(warnings).toEqual([]);
    expect(fired).toEqual([]);

    nowMs = 90;
    vi.advanceTimersByTime(1);
    expect(warnings).toEqual([
      { elapsedMs: 50, reason: STREAM_IDLE_WARNING_REASON },
    ]);

    nowMs = 140;
    vi.advanceTimersByTime(50);
    expect(fired).toEqual([]);
    expect(abortController.signal.aborted).toBe(false);
    expect(handle.firedAt).toBeNull();
  });

  test("stop cancels pending warning and timeout timers", () => {
    const abortController = new AbortController();
    const onWarning = vi.fn();
    const onFired = vi.fn();
    const handle = installStreamWatchdog({
      abortController,
      timeoutMs: 100,
      onWarning,
      onFired,
    });

    nowMs = 20;
    vi.advanceTimersByTime(20);
    handle.stop();

    nowMs = 200;
    vi.advanceTimersByTime(180);
    expect(onWarning).not.toHaveBeenCalled();
    expect(onFired).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(false);
    expect(handle.firedAt).toBeNull();
  });

  test("zero-timeout watchdog returns a no-op handle", () => {
    const abortController = new AbortController();
    const onWarning = vi.fn();
    const onFired = vi.fn();
    const handle = installStreamWatchdog({
      abortController,
      timeoutMs: 0,
      onWarning,
      onFired,
    });

    handle.kick();
    nowMs = 500;
    vi.advanceTimersByTime(500);
    handle.stop();

    expect(onWarning).not.toHaveBeenCalled();
    expect(onFired).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(false);
    expect(handle.firedAt).toBeNull();
  });

  test("distinguishes quiet reasoning from a dead socket", () => {
    expect(
      classifyStreamLiveness({
        nowMs: 100,
        startedAtMs: 0,
        lastByteMs: null,
        lastDeltaMs: null,
        warningMs: 50,
        deadMs: 100,
      }),
    ).toBe("dead");
    expect(
      classifyStreamLiveness({
        nowMs: 100,
        startedAtMs: 0,
        lastByteMs: 10,
        lastDeltaMs: 10,
        warningMs: 50,
        deadMs: 100,
      }),
    ).toBe("quiet");
    expect(
      classifyStreamLiveness({
        nowMs: 80,
        startedAtMs: 0,
        lastByteMs: 40,
        lastDeltaMs: null,
        warningMs: 50,
        deadMs: 100,
      }),
    ).toBe("quiet");
    expect(
      classifyStreamLiveness({
        nowMs: 20,
        startedAtMs: 0,
        lastByteMs: 10,
        lastDeltaMs: 10,
        warningMs: 50,
        deadMs: 100,
      }),
    ).toBe("live");
    expect(streamChunkHasDelta({ content: "" })).toBe(false);
    expect(streamChunkHasDelta({ content: "hi" })).toBe(true);
    expect(formatStreamQuietWarning(600_000)).toBe(
      "no output from the model for 10 minutes",
    );

    const deadAbort = new AbortController();
    const deadWarnings: string[] = [];
    const deadFired: string[] = [];
    installStreamWatchdog({
      abortController: deadAbort,
      timeoutMs: 100,
      onWarning: (info) => deadWarnings.push(info.reason),
      onFired: (info) => deadFired.push(info.reason),
    });
    nowMs = 100;
    vi.advanceTimersByTime(100);
    expect(deadWarnings).toEqual([STREAM_IDLE_WARNING_REASON]);
    expect(deadFired).toEqual([STREAM_IDLE_ABORT_REASON]);
    expect(deadAbort.signal.aborted).toBe(true);

    const quietAbort = new AbortController();
    const quietWarnings: string[] = [];
    const quietFired: string[] = [];
    const quiet = installStreamWatchdog({
      abortController: quietAbort,
      timeoutMs: 100,
      onWarning: (info) => quietWarnings.push(info.reason),
      onFired: (info) => quietFired.push(info.reason),
    });
    nowMs = 110;
    vi.advanceTimersByTime(10);
    quiet.kick("bytes");
    nowMs = 200;
    vi.advanceTimersByTime(90);
    expect(quietWarnings).toEqual([STREAM_IDLE_WARNING_REASON]);
    expect(quietFired).toEqual([]);
    expect(quietAbort.signal.aborted).toBe(false);

    const disabledAbort = new AbortController();
    const disabledWarnings: string[] = [];
    installStreamWatchdog({
      abortController: disabledAbort,
      timeoutMs: 0,
      warningMs: 100,
      onWarning: (info) => disabledWarnings.push(info.reason),
    });
    nowMs = 300;
    vi.advanceTimersByTime(100);
    expect(disabledWarnings).toEqual([STREAM_IDLE_WARNING_REASON]);
    expect(disabledAbort.signal.aborted).toBe(false);
  });
});
