import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  installStreamWatchdog,
  isStreamWatchdogEnabled,
  STREAM_IDLE_ABORT_REASON,
  STREAM_IDLE_WARNING_REASON,
} from "./stream-watchdog.js";

describe("stream-watchdog", () => {
  let nowMs = 0;
  let envDisable: string | undefined;
  let envTimeout: string | undefined;

  beforeEach(() => {
    envDisable = process.env.AGENC_DISABLE_STREAM_WATCHDOG;
    envTimeout = process.env.AGENC_STREAM_IDLE_TIMEOUT_MS;
    delete process.env.AGENC_STREAM_IDLE_TIMEOUT_MS;
    nowMs = 0;
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (envDisable === undefined) delete process.env.AGENC_DISABLE_STREAM_WATCHDOG;
    else process.env.AGENC_DISABLE_STREAM_WATCHDOG = envDisable;
    if (envTimeout === undefined) delete process.env.AGENC_STREAM_IDLE_TIMEOUT_MS;
    else process.env.AGENC_STREAM_IDLE_TIMEOUT_MS = envTimeout;
  });

  test("the feature gate remains available unless explicitly disabled", () => {
    delete process.env.AGENC_DISABLE_STREAM_WATCHDOG;
    expect(isStreamWatchdogEnabled()).toBe(true);

    process.env.AGENC_DISABLE_STREAM_WATCHDOG = "1";
    expect(isStreamWatchdogEnabled()).toBe(false);
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

  test("kick resets both warning and timeout windows", () => {
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
    expect(fired).toEqual([
      { elapsedMs: 100, reason: STREAM_IDLE_ABORT_REASON },
    ]);
    expect(handle.firedAt).toBe(140);
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

  test("disabled watchdog returns a no-op handle", () => {
    const abortController = new AbortController();
    const onWarning = vi.fn();
    const onFired = vi.fn();
    const handle = installStreamWatchdog({
      abortController,
      timeoutMs: 100,
      enabled: false,
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
});
