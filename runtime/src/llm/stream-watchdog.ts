/**
 * Stream idle watchdog — I-11.
 *
 * Hand-port of openclaude `services/api/claude.ts:1894-2433`
 * (`streamWatchdogEnabled`, `streamWatchdogFiredAt`,
 * `streamIdleAborted`) + codex `client.rs:1146`
 * (`stream_idle_timeout_ms` from provider info).
 *
 * Openclaude gates behind `CLAUDE_ENABLE_STREAM_WATCHDOG` env var
 * (opt-in). AgenC ships default-on because silent provider stalls
 * are pure latency burn; opt-out is `AGENC_DISABLE_STREAM_WATCHDOG=1`.
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

import { monotonicMs } from "../utils/monotonic.js";

/**
 * Default idle timeout. Matches openclaude `claude.ts:1898`. Override
 * via env `AGENC_STREAM_IDLE_TIMEOUT_MS` (positive integer) or via
 * explicit `timeoutMs` option on `installStreamWatchdog`.
 */
export const STREAM_IDLE_TIMEOUT_MS_DEFAULT = 90_000;

export function resolveStreamIdleTimeoutMs(): number {
  const raw = process.env.AGENC_STREAM_IDLE_TIMEOUT_MS;
  if (!raw) return STREAM_IDLE_TIMEOUT_MS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return STREAM_IDLE_TIMEOUT_MS_DEFAULT;
  return n;
}

/**
 * Whether the watchdog is enabled. AgenC ships default-on; opt-out
 * via `AGENC_DISABLE_STREAM_WATCHDOG=1`.
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

export interface StreamWatchdogHandle {
  /** Reset the idle timer on observed activity (per-chunk kick). */
  kick(): void;
  /** Stop the watchdog without firing (stream completed cleanly). */
  stop(): void;
  /** Whether this watchdog already fired. */
  readonly firedAt: number | null;
  /** Scheduled idle-timeout in ms (reflects env + override). */
  readonly timeoutMs: number;
}

export interface InstallStreamWatchdogOptions {
  /** AbortController to abort when the timer fires. Required — the
   *  watchdog signals the stream's abort channel to tear down the
   *  in-flight request. */
  readonly abortController: AbortController;
  /** Override for the idle timeout. Defaults to env / built-in
   *  constant. Pass 0 to disable explicitly (returns a no-op handle). */
  readonly timeoutMs?: number;
  /** Callback fired exactly once when the timer expires, before the
   *  `abortController.abort(...)` call. Emit I-8 `stream_error` here. */
  readonly onFired?: (info: { elapsedMs: number; reason: string }) => void;
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
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firedAtValue: number | null = null;
  let stopped = false;

  const fire = () => {
    if (stopped || firedAtValue !== null) return;
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
    timer = setTimeout(fire, timeoutMs);
    // Don't keep the event loop alive solely on the watchdog — the
    // owning stream promise is what holds the process open.
    if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  };

  schedule();

  return {
    kick() {
      if (stopped || firedAtValue !== null) return;
      lastKickMs = monotonicMs();
      if (timer) clearTimeout(timer);
      schedule();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    get firedAt() {
      return firedAtValue;
    },
    timeoutMs,
  };
}
