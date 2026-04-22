/**
 * Reconnection with exponential backoff for transient provider errors.
 *
 * Port of openclaude reconnection pattern: on transient network /
 * provider errors (ECONNRESET, ECONNREFUSED, 503, stream_idle), the
 * recovery layer sleeps with exponential backoff (1s → 30s cap,
 * ±25% jitter, 10-minute give-up budget) then resamples. Pending
 * tool-call re-injection ensures the model sees the same prompt
 * after the reconnect (history is unchanged).
 *
 * Invariants covered:
 *   I-7  (stream abort cascade) — reconnection runs as a recovery
 *        destination, not a terminal exit.
 *   I-42 (recovery re-entry cap) — every reconnect attempt counts
 *        against MAX_RECOVERY_REENTRIES via the ladder.
 *
 * @module
 */

import { monotonicMs } from "../utils/monotonic.js";
import type { Session } from "../session/session.js";
import { emitWarning } from "../session/event-log.js";

// ─────────────────────────────────────────────────────────────────────
// Backoff configuration
// ─────────────────────────────────────────────────────────────────────

export const RECONNECT_INITIAL_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const RECONNECT_GIVE_UP_MS = 600_000;
export const RECONNECT_JITTER_FRAC = 0.25; // ±25 %
export const RECONNECT_SLEEP_DETECTION_THRESHOLD_MS =
  RECONNECT_MAX_MS * 2;

/**
 * Compute the backoff delay for a given attempt (0-indexed). Caps at
 * `RECONNECT_MAX_MS`. ±25 % jitter prevents thundering-herd retry
 * storms when many sessions reconnect at once.
 */
export function computeBackoffMs(attempt: number): number {
  const base = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_INITIAL_MS * Math.pow(2, attempt),
  );
  const jitter = base * RECONNECT_JITTER_FRAC * (Math.random() * 2 - 1);
  return Math.max(RECONNECT_INITIAL_MS, Math.round(base + jitter));
}

// ─────────────────────────────────────────────────────────────────────
// Reconnect orchestration
// ─────────────────────────────────────────────────────────────────────

export type ReconnectOutcome<T> =
  | { readonly kind: "ok"; readonly value: T; readonly attempts: number }
  | {
      readonly kind: "exhausted";
      readonly attempts: number;
      readonly lastError: unknown;
    }
  | { readonly kind: "aborted"; readonly reason: string };

export interface ReconnectOpts<T> {
  readonly session: Session;
  readonly signal?: AbortSignal;
  readonly maxAttempts?: number;
  readonly giveUpMs?: number;
  readonly sleepDetectionThresholdMs?: number;
  readonly now?: () => number;
  readonly attempt: (attempt: number) => Promise<T>;
  readonly isTransient: (err: unknown) => boolean;
  readonly onTransientRetry?: (
    attempt: number,
    err: unknown,
  ) => Promise<boolean> | boolean;
}

/**
 * Retry `opts.attempt(n)` until either a transient error succeeds,
 * the optional `maxAttempts` cap trips, or the reconnect give-up
 * budget expires. Returns early on non-transient errors + surfaces
 * them.
 *
 * Emits `warning:'reconnecting'` with attempt + backoff + reason so
 * the event log captures every retry cycle.
 */
export async function reconnectWithBackoff<T>(
  opts: ReconnectOpts<T>,
): Promise<ReconnectOutcome<T>> {
  const maxAttempts = opts.maxAttempts;
  const giveUpMs = opts.giveUpMs ?? RECONNECT_GIVE_UP_MS;
  const sleepDetectionThresholdMs =
    opts.sleepDetectionThresholdMs ?? RECONNECT_SLEEP_DETECTION_THRESHOLD_MS;
  const now = opts.now ?? monotonicMs;
  let lastError: unknown = undefined;
  let reconnectAttempts = 0;
  let reconnectStartedAt: number | null = null;
  let lastReconnectAttemptAt: number | null = null;
  for (let attempt = 0; ; attempt += 1) {
    if (opts.signal?.aborted) {
      return {
        kind: "aborted",
        reason: String(opts.signal.reason ?? "aborted"),
      };
    }
    try {
      const value = await opts.attempt(attempt);
      return { kind: "ok", value, attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      if (!opts.isTransient(err)) {
        // Non-transient — bubble. Caller classifies + emits the
        // appropriate error/stream_error event.
        throw err;
      }
      const currentNow = now();
      if (reconnectStartedAt === null) {
        reconnectStartedAt = currentNow;
      }
      if (
        lastReconnectAttemptAt !== null &&
        currentNow - lastReconnectAttemptAt > sleepDetectionThresholdMs
      ) {
        reconnectStartedAt = currentNow;
        reconnectAttempts = 0;
      }
      lastReconnectAttemptAt = currentNow;
      if (maxAttempts !== undefined && attempt + 1 >= maxAttempts) {
        return {
          kind: "exhausted",
          attempts: attempt + 1,
          lastError,
        };
      }
      if (currentNow - reconnectStartedAt >= giveUpMs) {
        return {
          kind: "exhausted",
          attempts: attempt + 1,
          lastError,
        };
      }
      if ((await opts.onTransientRetry?.(attempt + 1, err)) === false) {
        return {
          kind: "exhausted",
          attempts: attempt + 1,
          lastError,
        };
      }
      const delay = computeBackoffMs(reconnectAttempts);
      reconnectAttempts += 1;
      emitWarning(
        opts.session.eventLog,
        opts.session.nextInternalSubId(),
        "reconnecting",
        `transient provider error (attempt ${attempt + 1}${
          maxAttempts !== undefined ? `/${maxAttempts}` : ""
        }); sleeping ${delay}ms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await sleep(delay, opts.signal);
      if (opts.signal?.aborted) {
        return {
          kind: "aborted",
          reason: String(opts.signal.reason ?? "aborted"),
        };
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// sleep with abort support
// ─────────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
// Suspend-aware elapsed detection (wall-clock sanity check)
// ─────────────────────────────────────────────────────────────────────

/**
 * Detects a wall-clock gap > 60s between two monotonic samples,
 * which openclaude treats as "process likely sleeping" and resets
 * the backoff budget. Exposed for callers orchestrating multiple
 * reconnect cycles.
 */
export function detectSuspend(lastMonotonicMs: number): {
  readonly suspended: boolean;
  readonly gapMs: number;
} {
  const now = monotonicMs();
  const gapMs = now - lastMonotonicMs;
  return {
    suspended: gapMs > RECONNECT_SLEEP_DETECTION_THRESHOLD_MS,
    gapMs,
  };
}
