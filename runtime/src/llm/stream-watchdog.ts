/**
 * Stream idle watchdog — I-11.
 *
 * AgenC stream-idle deadline guard (`streamWatchdogEnabled`,
 * `streamWatchdogFiredAt`, `streamIdleAborted`) driven by
 * `stream_idle_timeout_ms` from provider info.
 *
 * Abort is opt-in (`timeoutMs` > 0) and fires only when the socket never
 * received bytes. Heartbeats (`kick("bytes")`) keep that abort from firing.
 * Model deltas (`kick("delta")`) reset the quiet-warning window. A zero abort
 * timeout still warns when `onWarning` is set, so long grok-4.6 xhigh quiet
 * phases stay alive with a ticker signal instead of a hard kill.
 *
 * Timers use monotonic clock (I-82) via `monotonicMs()`.
 *
 * @module
 */

import { monotonicMs } from "./_deps/monotonic.js";

/**
 * There is deliberately no default idle timeout. A positive operator value is
 * required to install a deadline.
 */
const STREAM_IDLE_TIMEOUT_MS_DEFAULT = 0;

export function resolveStreamIdleTimeoutMs(preferredMs?: number): number {
  // `preferredMs` carries canonical config (`stream_watchdog_timeout_ms`) or
  // an explicitly selected provider-client value. Environment input is folded
  // into canonical config at ingress and is never rediscovered here.
  if (
    preferredMs !== undefined &&
    Number.isFinite(preferredMs) &&
    preferredMs > 0
  ) {
    return Math.trunc(preferredMs);
  }
  return STREAM_IDLE_TIMEOUT_MS_DEFAULT;
}

/**
 * Session-level idle-timeout resolution: explicit canonical config > disabled.
 * A provider suggestion may raise an explicitly configured timeout, but it
 * never creates a deadline by itself. Provider silence is not evidence of a
 * dead turn, and healthy agent/model calls may remain silent for hours.
 */
export function resolveSessionStreamIdleTimeoutMs(input: {
  readonly configuredMs?: number;
  readonly providerSuggestedMs?: number;
}): number {
  const configured =
    input.configuredMs !== undefined &&
    Number.isFinite(input.configuredMs) &&
    input.configuredMs > 0
      ? input.configuredMs
      : undefined;
  const suggested =
    input.providerSuggestedMs !== undefined &&
    Number.isFinite(input.providerSuggestedMs) &&
    input.providerSuggestedMs > 0
      ? input.providerSuggestedMs
      : undefined;
  if (configured === undefined) {
    return resolveStreamIdleTimeoutMs();
  }
  const preferred =
    suggested !== undefined
      ? Math.max(configured, suggested)
      : configured;
  return resolveStreamIdleTimeoutMs(preferred);
}

/** Soft "no model delta" warning when abort is disabled. Matches the session default idle window. */
export const STREAM_QUIET_WARNING_MS = 600_000;

export type StreamWatchdogKickSource = "bytes" | "delta";
export type StreamLiveness = "live" | "quiet" | "dead";

export function classifyStreamLiveness(input: {
  readonly nowMs: number;
  readonly startedAtMs: number;
  readonly lastByteMs: number | null;
  readonly lastDeltaMs: number | null;
  readonly warningMs: number;
  readonly deadMs: number;
}): StreamLiveness {
  const sinceStart = input.nowMs - input.startedAtMs;
  if (
    input.deadMs > 0 &&
    input.lastByteMs === null &&
    sinceStart >= input.deadMs
  ) {
    return "dead";
  }
  const sinceDelta = input.nowMs - (input.lastDeltaMs ?? input.startedAtMs);
  if (input.warningMs > 0 && sinceDelta >= input.warningMs) {
    return "quiet";
  }
  return "live";
}

export function resolveStreamIdleWarningMs(input: {
  readonly timeoutMs: number;
  readonly warningMs?: number;
}): number {
  if (
    input.warningMs !== undefined &&
    Number.isFinite(input.warningMs) &&
    input.warningMs > 0
  ) {
    return Math.trunc(input.warningMs);
  }
  if (input.timeoutMs > 0) {
    return Math.trunc(input.timeoutMs / 2);
  }
  return STREAM_QUIET_WARNING_MS;
}

export function formatStreamQuietWarning(elapsedMs: number): string {
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
  const unit = minutes === 1 ? "minute" : "minutes";
  return `no output from the model for ${minutes} ${unit}`;
}

export function streamChunkHasDelta(chunk: {
  readonly content: string;
  readonly thinkingDelta?: unknown;
  readonly reasoningSummaryDelta?: unknown;
  readonly toolInputDelta?: unknown;
  readonly thinkingBlockStart?: unknown;
  readonly toolInputBlockStart?: unknown;
  readonly toolCalls?: readonly unknown[];
}): boolean {
  return (
    chunk.content.length > 0 ||
    chunk.thinkingDelta !== undefined ||
    chunk.reasoningSummaryDelta !== undefined ||
    chunk.toolInputDelta !== undefined ||
    chunk.thinkingBlockStart !== undefined ||
    chunk.toolInputBlockStart !== undefined ||
    (chunk.toolCalls !== undefined && chunk.toolCalls.length > 0)
  );
}

/**
 * Reason string for the abort. Callers observing `signal.reason`
 * check for this exact value.
 */
export const STREAM_IDLE_ABORT_REASON = "stream_idle";
export const STREAM_IDLE_WARNING_REASON = "stream_idle_warning";

export interface StreamWatchdogHandle {
  /** Heartbeat (`bytes`) keeps a dead-socket abort from firing. A model
   *  `delta` also resets the quiet-warning window. */
  kick(source?: StreamWatchdogKickSource): void;
  /** Stop the watchdog without firing (stream completed cleanly). */
  stop(): void;
  /** Whether this watchdog already fired. */
  readonly firedAt: number | null;
  /** Scheduled idle-timeout in ms; `0` means disabled. */
  readonly timeoutMs: number;
}

export interface InstallStreamWatchdogOptions {
  /** AbortController to abort when the timer fires. Required — the
   *  watchdog signals the stream's abort channel to tear down the
   *  in-flight request. */
  readonly abortController: AbortController;
  /** Override for the idle timeout. Defaults to disabled. Pass 0 to
   *  disable the dead-socket abort. */
  readonly timeoutMs?: number;
  /** Override for the no-delta warning. Defaults to half of `timeoutMs`,
   *  or {@link STREAM_QUIET_WARNING_MS} when abort is disabled. */
  readonly warningMs?: number;
  /** Callback fired exactly once when the timer expires, before the
   *  `abortController.abort(...)` call. Emit I-8 `stream_error` here. */
  readonly onFired?: (info: { elapsedMs: number; reason: string }) => void;
  /** Callback fired once per idle window when the stream is quiet or dead. */
  readonly onWarning?: (info: { elapsedMs: number; reason: string }) => void;
}

/**
 * Install a fresh watchdog on the given AbortController. Returns a
 * handle with `kick()` / `stop()` + monotonic start metadata.
 *
 * The returned handle is safe to use after the stream completes —
 * `stop()` / `kick()` after fire is a no-op.
 *
 * A zero abort timeout still warns when `onWarning` is set. Abort fires
 * only for a socket that never received bytes.
 */
export function installStreamWatchdog(
  options: InstallStreamWatchdogOptions,
): StreamWatchdogHandle {
  const timeoutMs = options.timeoutMs ?? resolveStreamIdleTimeoutMs();
  const warningMs = resolveStreamIdleWarningMs({
    timeoutMs,
    ...(options.warningMs !== undefined ? { warningMs: options.warningMs } : {}),
  });

  if (timeoutMs <= 0 && (warningMs <= 0 || options.onWarning === undefined)) {
    return {
      kick() {},
      stop() {},
      get firedAt() {
        return null;
      },
      timeoutMs,
    };
  }

  const startedAtMs = monotonicMs();
  let lastByteMs: number | null = null;
  let lastDeltaMs: number | null = null;
  let warningTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let firedAtValue: number | null = null;
  let warned = false;
  let stopped = false;

  const clearTimers = () => {
    if (warningTimer) {
      clearTimeout(warningTimer);
      warningTimer = null;
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  };

  const withUnref = (timer: ReturnType<typeof setTimeout> | null): void => {
    if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  };

  const warn = () => {
    if (stopped || firedAtValue !== null || warned) return;
    warningTimer = null;
    warned = true;
    const nowMs = monotonicMs();
    options.onWarning?.({
      elapsedMs: nowMs - (lastDeltaMs ?? startedAtMs),
      reason: STREAM_IDLE_WARNING_REASON,
    });
  };

  const fire = () => {
    if (stopped || firedAtValue !== null || lastByteMs !== null) return;
    timeoutTimer = null;
    firedAtValue = monotonicMs();
    const elapsedMs = firedAtValue - startedAtMs;
    try {
      options.onFired?.({ elapsedMs, reason: STREAM_IDLE_ABORT_REASON });
    } finally {
      options.abortController.abort(STREAM_IDLE_ABORT_REASON);
    }
  };

  const schedule = () => {
    if (stopped || firedAtValue !== null) return;
    const nowMs = monotonicMs();
    if (warningMs > 0 && !warned) {
      const delay = Math.max(
        0,
        warningMs - (nowMs - (lastDeltaMs ?? startedAtMs)),
      );
      warningTimer = setTimeout(warn, delay);
      withUnref(warningTimer);
    }
    if (timeoutMs > 0 && lastByteMs === null) {
      timeoutTimer = setTimeout(fire, Math.max(0, timeoutMs - (nowMs - startedAtMs)));
      withUnref(timeoutTimer);
    }
  };

  schedule();

  return {
    kick(source: StreamWatchdogKickSource = "delta") {
      if (stopped || firedAtValue !== null) return;
      const nowMs = monotonicMs();
      lastByteMs = nowMs;
      if (source === "delta") {
        lastDeltaMs = nowMs;
        warned = false;
      }
      clearTimers();
      schedule();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimers();
    },
    get firedAt() {
      return firedAtValue;
    },
    timeoutMs,
  };
}
