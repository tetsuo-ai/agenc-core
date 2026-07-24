/**
 * Reconnection with exponential backoff for transient provider errors.
 *
 * Port of agenc reconnection pattern: on transient network /
 * provider errors (ECONNRESET, ECONNREFUSED, 503, stream_idle), the
 * recovery layer sleeps with exponential backoff (1s → 30s cap,
 * ±25% jitter) then resamples. There is no implicit wall-clock give-up
 * budget; callers may provide one explicitly. Pending
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

import { monotonicMs } from "./_deps/monotonic.js";
import type { Session } from "../session/session.js";
import { emitWarning } from "../session/event-log.js";

// ─────────────────────────────────────────────────────────────────────
// Backoff configuration
// ─────────────────────────────────────────────────────────────────────

export const RECONNECT_INITIAL_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_FRAC = 0.25; // ±25 %
export const RECONNECT_SLEEP_DETECTION_THRESHOLD_MS =
  RECONNECT_MAX_MS * 2;

/**
 * Upper bound on a server-directed Retry-After we will honor before
 * sleeping. A rate-limited provider (429/529) reports `retryAfterMs`,
 * which legitimately exceeds `RECONNECT_MAX_MS` (the cap on the local
 * 2^attempt backoff). We honor the server's cooldown over the local
 * jitter so we stop hammering during its window, but clamp here so a
 * pathological header can't park a turn for an unbounded stretch. Five
 * minutes mirrors the `withRetry` persistent-mode max backoff.
 */
export const RECONNECT_RETRY_AFTER_CEILING_MS = 5 * 60 * 1_000;

/**
 * Extract a server-directed retry delay (ms) from a transient error, if
 * one is present. `LLMRateLimitError` (429) and the HTTP-level provider
 * error (429/529) both expose `retryAfterMs`; the live loop may also see
 * the error wrapped (e.g. `StreamModelError.cause`), so the immediate
 * `cause` is consulted as a fallback. Returns `undefined` when no usable
 * server directive is found, leaving the caller on pure 2^attempt
 * backoff. Clamped to `RECONNECT_RETRY_AFTER_CEILING_MS`.
 */
export function serverDirectedRetryAfterMs(err: unknown): number | undefined {
  const direct = readRetryAfterMs(err);
  if (direct !== undefined) return direct;
  if (err && typeof err === "object") {
    return readRetryAfterMs((err as { readonly cause?: unknown }).cause);
  }
  return undefined;
}

function readRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const value = (err as { readonly retryAfterMs?: unknown }).retryAfterMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(value, RECONNECT_RETRY_AFTER_CEILING_MS);
}

/**
 * Compute the backoff delay for a given attempt (0-indexed). Caps at
 * `RECONNECT_MAX_MS`. ±25 % jitter prevents thundering-herd retry
 * storms when many sessions reconnect at once.
 *
 * When the provider returned a server-directed cooldown
 * (`retryAfterMs`, from a 429/529 Retry-After), the result is at least
 * that long: we sleep `max(retryAfterMs, computedBackoff)` so a
 * rate-limited provider is not hammered during its own cooldown window.
 * `retryAfterMs` is already clamped to `RECONNECT_RETRY_AFTER_CEILING_MS`
 * by `serverDirectedRetryAfterMs`.
 */
export function computeBackoffMs(
  attempt: number,
  retryAfterMs?: number,
): number {
  const base = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_INITIAL_MS * Math.pow(2, attempt),
  );
  const jitter = base * RECONNECT_JITTER_FRAC * (Math.random() * 2 - 1);
  const computed = Math.max(RECONNECT_INITIAL_MS, Math.round(base + jitter));
  if (
    typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
  ) {
    return Math.max(computed, retryAfterMs);
  }
  return computed;
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
  /** Optional operator/caller deadline. Unset retries without a time ceiling. */
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
  const giveUpMs = opts.giveUpMs;
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
      if (
        giveUpMs !== undefined &&
        currentNow - reconnectStartedAt >= giveUpMs
      ) {
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
      // Honor a server-directed cooldown (429/529 Retry-After) when the
      // transient error carries one: sleep at least that long so a
      // rate-limited provider is not hammered during its own window.
      const retryAfterMs = serverDirectedRetryAfterMs(err);
      const delay = computeBackoffMs(reconnectAttempts, retryAfterMs);
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
    // gaphunt3 #45: detach onAbort on the normal timeout path too. `{ once: true }`
    // only auto-removes a listener AFTER abort fires; on the common (non-aborted)
    // timeout path the listener would otherwise leak on the long-lived turn signal,
    // accumulating one dead closure per retry across a reconnect storm.
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    if (signal) {
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
 * which AgenC treats as "process likely sleeping" and resets
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
