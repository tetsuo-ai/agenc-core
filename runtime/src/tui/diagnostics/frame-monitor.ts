import type { FrameEvent } from "../ink/frame.js";

/**
 * Aggregate FPS metrics derived from per-frame durations. Mirrors the
 * shape exposed by `FpsMetricsContext.useFpsMetrics()` so React surfaces
 * can read it directly without a translation layer.
 */
export interface FpsMetrics {
  /** Mean frames per second across the monitor's lifetime. */
  readonly averageFps: number;
  /** Low-1% FPS (1 / p99 frame time). Captures stutters. */
  readonly low1PctFps: number;
}

/**
 * Always-on FPS tracker. Independent of the env-gated debug logger so
 * status surfaces can read live metrics regardless of
 * `AGENC_TUI_FRAME_DEBUG`. Wire this into the ink instance's onFrame
 * pipeline via `recordFrame(event.durationMs)` (or `record(durationMs)`)
 * and read with `getMetrics()`.
 */
export interface FpsTracker {
  /** Record a single frame's render time in ms. */
  readonly record: (durationMs: number) => void;
  /** Compute the current aggregate metrics. `undefined` until at least one frame has landed. */
  readonly getMetrics: () => FpsMetrics | undefined;
  /** Reset all accumulated frame data. Useful around a TUI re-mount. */
  readonly reset: () => void;
}

export function createFpsTracker(options: {
  readonly now?: () => number;
} = {}): FpsTracker {
  const now = options.now ?? (() => performance.now());
  const frameDurations: number[] = [];
  let firstRenderTime: number | undefined;
  let lastRenderTime: number | undefined;

  return {
    record(durationMs: number) {
      const t = now();
      if (firstRenderTime === undefined) {
        firstRenderTime = t;
      }
      lastRenderTime = t;
      frameDurations.push(durationMs);
    },
    getMetrics() {
      if (
        frameDurations.length === 0 ||
        firstRenderTime === undefined ||
        lastRenderTime === undefined
      ) {
        return undefined;
      }
      const totalTimeMs = lastRenderTime - firstRenderTime;
      if (totalTimeMs <= 0) return undefined;

      const totalFrames = frameDurations.length;
      const averageFps = totalFrames / (totalTimeMs / 1000);

      const sorted = frameDurations.slice().sort((a, b) => b - a);
      const p99Index = Math.max(0, Math.ceil(sorted.length * 0.01) - 1);
      const p99FrameTimeMs = sorted[p99Index]!;
      const low1PctFps = p99FrameTimeMs > 0 ? 1000 / p99FrameTimeMs : 0;

      return {
        averageFps: Math.round(averageFps * 100) / 100,
        low1PctFps: Math.round(low1PctFps * 100) / 100,
      };
    },
    reset() {
      frameDurations.length = 0;
      firstRenderTime = undefined;
      lastRenderTime = undefined;
    },
  };
}

export interface FrameMonitorEnv {
  readonly AGENC_TUI_FRAME_DEBUG?: string;
  readonly AGENC_TUI_FRAME_BUDGET_MS?: string;
  readonly AGENC_TUI_INPUT_BUDGET_MS?: string;
  readonly AGENC_TUI_FRAME_REPORT_EVERY?: string;
}

export interface FrameMonitorOptions {
  readonly enabled: boolean;
  readonly slowFrameMs: number;
  readonly inputLatencyMs: number;
  readonly reportEvery: number;
  readonly now?: () => number;
  readonly write?: (line: string) => void;
  readonly memoryUsage?: () => NodeJS.MemoryUsage;
}

export interface TuiFrameMonitor {
  readonly onFrame: (event: FrameEvent) => void;
  readonly noteInput: () => void;
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function readPositiveNumber(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
}

export function frameMonitorOptionsFromEnv(
  env: FrameMonitorEnv = process.env,
): FrameMonitorOptions {
  return {
    enabled: isTruthy(env.AGENC_TUI_FRAME_DEBUG),
    slowFrameMs: readPositiveNumber(env.AGENC_TUI_FRAME_BUDGET_MS, 50),
    inputLatencyMs: readPositiveNumber(env.AGENC_TUI_INPUT_BUDGET_MS, 80),
    reportEvery: Math.max(
      1,
      Math.floor(readPositiveNumber(env.AGENC_TUI_FRAME_REPORT_EVERY, 120)),
    ),
  };
}

export function createTuiFrameMonitor(
  options: FrameMonitorOptions,
): TuiFrameMonitor | null {
  if (!options.enabled) return null;

  const now = options.now ?? (() => performance.now());
  const write =
    options.write ??
    ((line: string) => {
      process.stderr.write(line);
    });
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());

  let frameCount = 0;
  let slowFrames = 0;
  let flickerFrames = 0;
  let maxDurationMs = 0;
  let maxInputLatencyMs = 0;
  let lastInputAt: number | null = null;

  function emit(reason: string, event: FrameEvent, inputLatency: number | null) {
    const phases = event.phases;
    const phaseSummary = phases
      ? ` renderer=${phases.renderer.toFixed(1)} diff=${phases.diff.toFixed(
          1,
        )} optimize=${phases.optimize.toFixed(1)} write=${phases.write.toFixed(
          1,
        )} patches=${phases.patches} yoga=${phases.yoga.toFixed(
          1,
        )} commit=${phases.commit.toFixed(1)} yogaVisited=${
          phases.yogaVisited
        } yogaMeasured=${phases.yogaMeasured} yogaCacheHits=${
          phases.yogaCacheHits
        } yogaLive=${phases.yogaLive}`
      : "";
    const inputSummary =
      inputLatency === null ? "" : ` inputLatency=${inputLatency.toFixed(1)}ms`;
    const mem = memoryUsage();
    const memorySummary = ` rss=${formatMiB(mem.rss)} heap=${formatMiB(
      mem.heapUsed,
    )}`;
    write(
      `[agenc:tui-frame] ${reason} frame=${frameCount} duration=${event.durationMs.toFixed(
        1,
      )}ms max=${maxDurationMs.toFixed(1)}ms slow=${slowFrames} flicker=${flickerFrames}${inputSummary}${memorySummary}${phaseSummary}\n`,
    );
  }

  return {
    noteInput() {
      lastInputAt = now();
    },

    onFrame(event: FrameEvent) {
      frameCount += 1;
      maxDurationMs = Math.max(maxDurationMs, event.durationMs);
      let inputLatency: number | null = null;
      if (lastInputAt !== null) {
        inputLatency = Math.max(0, now() - lastInputAt);
        maxInputLatencyMs = Math.max(maxInputLatencyMs, inputLatency);
        lastInputAt = null;
      }

      const hasSlowFrame = event.durationMs > options.slowFrameMs;
      const hasSlowInput =
        inputLatency !== null && inputLatency > options.inputLatencyMs;
      const hasFlicker = event.flickers.length > 0;

      if (hasSlowFrame) slowFrames += 1;
      if (hasFlicker) flickerFrames += 1;

      if (hasSlowFrame || hasSlowInput || hasFlicker) {
        emit(
          hasFlicker ? "flicker" : hasSlowInput ? "slow-input" : "slow-frame",
          event,
          inputLatency,
        );
        return;
      }

      if (frameCount % options.reportEvery === 0) {
        const mem = memoryUsage();
        write(
          `[agenc:tui-frame] summary frames=${frameCount} max=${maxDurationMs.toFixed(
            1,
          )}ms maxInputLatency=${maxInputLatencyMs.toFixed(
            1,
          )}ms slow=${slowFrames} flicker=${flickerFrames} rss=${formatMiB(
            mem.rss,
          )} heap=${formatMiB(mem.heapUsed)}\n`,
        );
      }
    },
  };
}
