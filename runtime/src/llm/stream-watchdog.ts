/**
 * Stream idle watchdog — I-11.
 *
 * AgenC stream-idle deadline guard (`streamWatchdogEnabled`,
 * `streamWatchdogFiredAt`, `streamIdleAborted`) plus runtime
 * `client.rs:1146`
 * (`stream_idle_timeout_ms` from provider info).
 *
 * Providers may supply a provider-specific default deadline. Operators can
 * override it with `AGENC_STREAM_IDLE_TIMEOUT_MS` or explicit runtime
 * configuration; `0` disables it. Providers that do not supply a default
 * remain unbounded, preserving long silent reasoning/tool-argument generation
 * where the wire contract does not expose liveness.
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

/** Generic providers remain unbounded unless configured by the operator. */
const STREAM_IDLE_TIMEOUT_MS_DEFAULT = 0;

/**
 * OpenAI Responses streams emit explicit progress events during healthy work.
 * Eight minutes bounds true transport silence while leaving ample room for
 * long reasoning/tool generation between those events.
 */
export const OPENAI_STREAM_IDLE_TIMEOUT_MS_DEFAULT = 8 * 60_000;

function readEnvStreamIdleTimeoutMs(): number | undefined {
  const raw = process.env.AGENC_STREAM_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.trunc(parsed)
    : undefined;
}

export function resolveStreamIdleTimeoutMs(preferredMs?: number): number {
  const envTimeoutMs = readEnvStreamIdleTimeoutMs();
  if (envTimeoutMs !== undefined) return envTimeoutMs;
  // `preferredMs` carries config (`stream_watchdog_timeout_ms`) or a
  // provider-declared value. Env wins for operator escape-hatch parity.
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
 * Session-level idle-timeout resolution:
 * env > explicit config > provider default > disabled.
 *
 * `0` is an authoritative opt-out at both explicit layers. A provider
 * suggestion may raise a positive configured timeout, but it never creates a
 * deadline by itself. A provider default creates a deadline only when neither
 * env nor config made an explicit choice.
 */
export function resolveSessionStreamIdleTimeoutMs(input: {
  readonly configuredMs?: number;
  readonly providerDefaultMs?: number;
  readonly providerSuggestedMs?: number;
}): number {
  const envTimeoutMs = readEnvStreamIdleTimeoutMs();
  if (envTimeoutMs !== undefined) return envTimeoutMs;

  const configured =
    input.configuredMs !== undefined &&
    Number.isFinite(input.configuredMs) &&
    input.configuredMs >= 0
      ? Math.trunc(input.configuredMs)
      : undefined;
  const suggested =
    input.providerSuggestedMs !== undefined &&
    Number.isFinite(input.providerSuggestedMs) &&
    input.providerSuggestedMs > 0
      ? input.providerSuggestedMs
      : undefined;
  if (configured !== undefined) {
    if (configured === 0) return 0;
    return suggested !== undefined
      ? Math.max(configured, suggested)
      : configured;
  }

  const providerDefault =
    input.providerDefaultMs !== undefined &&
    Number.isFinite(input.providerDefaultMs) &&
    input.providerDefaultMs > 0
      ? Math.trunc(input.providerDefaultMs)
      : undefined;
  return providerDefault ?? STREAM_IDLE_TIMEOUT_MS_DEFAULT;
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

/** Typed stream-silence failure used by the safe reconnect classifier. */
export class StreamIdleError extends Error {
  readonly code = STREAM_IDLE_ABORT_REASON;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`${STREAM_IDLE_ABORT_REASON}: no data for ${timeoutMs}ms`);
    this.name = "StreamIdleError";
    this.timeoutMs = timeoutMs;
  }
}

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
    // External/user cancellation owns the outcome once the shared controller
    // is already aborted. Do not let a later timer relabel that cancellation
    // as provider stream silence while the provider promise is still settling.
    if (
      stopped ||
      firedAtValue !== null ||
      options.abortController.signal.aborted
    ) {
      clearTimers();
      return;
    }
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
