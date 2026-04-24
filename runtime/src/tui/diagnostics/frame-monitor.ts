import type { FrameEvent } from "../ink/frame.js";

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
        )} patches=${phases.patches}`
      : "";
    const inputSummary =
      inputLatency === null ? "" : ` inputLatency=${inputLatency.toFixed(1)}ms`;
    write(
      `[agenc:tui-frame] ${reason} frame=${frameCount} duration=${event.durationMs.toFixed(
        1,
      )}ms max=${maxDurationMs.toFixed(1)}ms slow=${slowFrames} flicker=${flickerFrames}${inputSummary}${phaseSummary}\n`,
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
        write(
          `[agenc:tui-frame] summary frames=${frameCount} max=${maxDurationMs.toFixed(
            1,
          )}ms maxInputLatency=${maxInputLatencyMs.toFixed(
            1,
          )}ms slow=${slowFrames} flicker=${flickerFrames}\n`,
        );
      }
    },
  };
}
