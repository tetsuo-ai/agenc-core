/**
 * Reconnection with exponential backoff for transient provider errors.
 *
 * Port of openclaude reconnection pattern: on transient network /
 * provider errors (ECONNRESET, ECONNREFUSED, 503, stream_idle), the
 * recovery layer sleeps with exponential backoff (500ms → 8s cap)
 * then resamples. Pending tool-call re-injection ensures the model
 * sees the same prompt after the reconnect (history is unchanged).
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

export const RECONNECT_INITIAL_MS = 500;
export const RECONNECT_MAX_MS = 8_000;
export const RECONNECT_MAX_ATTEMPTS = 5;
export const RECONNECT_JITTER_FRAC = 0.25; // ±25 %

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
  readonly attempt: (attempt: number) => Promise<T>;
  readonly isTransient: (err: unknown) => boolean;
}

/**
 * Retry `opts.attempt(n)` up to `maxAttempts` times, sleeping
 * exponentially between attempts. Returns early on non-transient
 * errors + surfaces them.
 *
 * Emits `warning:'reconnecting'` with attempt + backoff + reason so
 * the event log captures every retry cycle.
 */
export async function reconnectWithBackoff<T>(
  opts: ReconnectOpts<T>,
): Promise<ReconnectOutcome<T>> {
  const max = opts.maxAttempts ?? RECONNECT_MAX_ATTEMPTS;
  let lastError: unknown = undefined;
  for (let attempt = 0; attempt < max; attempt += 1) {
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
      const delay = computeBackoffMs(attempt);
      emitWarning(
        opts.session.eventLog,
        opts.session.nextInternalSubId(),
        "reconnecting",
        `transient provider error (attempt ${attempt + 1}/${max}); sleeping ${delay}ms: ${
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
  return { kind: "exhausted", attempts: max, lastError };
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
  return { suspended: gapMs > 60_000, gapMs };
}
