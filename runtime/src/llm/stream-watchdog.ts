/**
 * Stream idle watchdog — I-11.
 *
 * AgenC stream-idle deadline guard (`streamWatchdogEnabled`,
 * `streamWatchdogFiredAt`, `streamIdleAborted`) plus runtime
 * `client.rs:1146`
 * (`stream_idle_timeout_ms` from provider info).
 *
 * The watchdog has no implicit deadline. Operators may opt in with a
 * positive `AGENC_STREAM_IDLE_TIMEOUT_MS` value or an explicit runtime
 * configuration value; `0` disables it. This keeps long silent reasoning and
 * tool-argument generation valid for arbitrarily long turns.
 *
 * Timers use monotonic clock (I-82) via `monotonicMs()` — immune to
 * NTP corrections, `date` set, suspend/resume, container clock skew.
 *
 * ## Usage patterns
 *
 * **Streaming** (T7 `chatStream`): call `kick()` on every received
 * chunk. The watchdog fires abort after `STREAM_IDLE_TIMEOUT_MS` of
 * silence since the last kick.
 *
 * **Total-timeout fallback** (T5 `chat()`): install with no kicks —
 * the watchdog fires after `STREAM_IDLE_TIMEOUT_MS` from install.
 * This is a coarse fallback because we can't observe intra-response
 * progress without a streaming channel; T7 replaces it with real
 * per-chunk kicks once `chatStream` wires in.
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
  const raw = process.env.AGENC_STREAM_IDLE_TIMEOUT_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  }
  // `preferredMs` carries config (`stream_watchdog_timeout_ms`) or a
  // provider-declared tolerance (e.g. grok's silent tool-argument
  // generation). Env wins over both for operator escape-hatch parity.
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
 * Session-level idle-timeout resolution: env > explicit config > disabled.
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

/**
 * Whether an explicitly configured watchdog is allowed to run. The timeout
 * resolver still returns `0` by default, so this gate alone never creates a
 * deadline. Opt out via `AGENC_DISABLE_STREAM_WATCHDOG=1`.
 */
export function isStreamWatchdogEnabled(): boolean {
  const raw = process.env.AGENC_DISABLE_STREAM_WATCHDOG;
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  return !(
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

/**
 * Reason string for the abort. Callers observing `signal.reason`
 * check for this exact value.
 */
export const STREAM_IDLE_ABORT_REASON = "stream_idle";
export const STREAM_IDLE_WARNING_REASON = "stream_idle_warning";

export interface StreamWatchdogHandle {
  /** Reset the idle timer on observed activity (per-chunk kick). */
  kick(): void;
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
  /** Override for the idle timeout. Defaults to env / disabled. Pass 0 to
   *  disable explicitly (returns a no-op handle). */
  readonly timeoutMs?: number;
  /** Callback fired exactly once when the timer expires, before the
   *  `abortController.abort(...)` call. Emit I-8 `stream_error` here. */
  readonly onFired?: (info: { elapsedMs: number; reason: string }) => void;
  /** Callback fired once per idle window at half the timeout. Use for
   *  non-fatal diagnostics or typed warnings before the hard abort. */
  readonly onWarning?: (info: { elapsedMs: number; reason: string }) => void;
  /** Force-enable or force-disable irrespective of env. */
  readonly enabled?: boolean;
}

/**
 * Install a fresh watchdog on the given AbortController. Returns a
 * handle with `kick()` / `stop()` + monotonic start metadata.
 *
 * The returned handle is safe to use after the stream completes —
 * `stop()` / `kick()` after fire is a no-op.
 *
 * If the watchdog is disabled (env opt-out or `enabled: false`), the
 * handle no-ops and never fires. This lets every call site use the
 * same code path without conditional branches.
 */
export function installStreamWatchdog(
  options: InstallStreamWatchdogOptions,
): StreamWatchdogHandle {
  const enabled =
    options.enabled === undefined ? isStreamWatchdogEnabled() : options.enabled;
  const timeoutMs = options.timeoutMs ?? resolveStreamIdleTimeoutMs();

  if (!enabled || timeoutMs <= 0) {
    // Disabled — return a no-op handle.
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
  let lastKickMs = startedAtMs;
  let warningTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let firedAtValue: number | null = null;
  let stopped = false;
  const warningMs = timeoutMs / 2;

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
    if (stopped || firedAtValue !== null) return;
    warningTimer = null;
    const warnedAtMs = monotonicMs();
    options.onWarning?.({
      elapsedMs: warnedAtMs - lastKickMs,
      reason: STREAM_IDLE_WARNING_REASON,
    });
  };

  const fire = () => {
    if (stopped || firedAtValue !== null) return;
    timeoutTimer = null;
    firedAtValue = monotonicMs();
    const elapsedMs = firedAtValue - lastKickMs;
    try {
      options.onFired?.({ elapsedMs, reason: STREAM_IDLE_ABORT_REASON });
    } finally {
      options.abortController.abort(STREAM_IDLE_ABORT_REASON);
    }
  };

  const schedule = () => {
    if (stopped || firedAtValue !== null) return;
    warningTimer = setTimeout(warn, warningMs);
    timeoutTimer = setTimeout(fire, timeoutMs);
    // Don't keep the event loop alive solely on the watchdog — the
    // owning stream promise is what holds the process open.
    withUnref(warningTimer);
    withUnref(timeoutTimer);
  };

  schedule();

  return {
    kick() {
      if (stopped || firedAtValue !== null) return;
      lastKickMs = monotonicMs();
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
