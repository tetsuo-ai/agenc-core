/**
 * Finite reconnect orchestration for transient provider failures.
 *
 * Retry eligibility stays with the caller. This module owns only finite ladder
 * admission, conservative elapsed accounting, full-jitter delay selection, and
 * abort-aware sleeping.
 */

import { monotonicMs } from "./_deps/monotonic.js";
import {
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  calculateReconnectDelay,
  classifyRetryAfterMilliseconds,
  validateRetryAfterDirective,
  type ReconnectDelayDecision,
  type ReconnectDelayExhaustionReason,
  type RetryAfterClassification,
  type RetryAfterDirective,
  type RetryAfterInvalidReason,
} from "./reconnect-policy.js";
import { emitWarning } from "../session/event-log.js";
import type { Session } from "../session/session.js";

export {
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  RECONNECT_RETRY_AFTER_CEILING_MS,
} from "./reconnect-policy.js";
export type {
  ReconnectDelayDecision,
  RetryAfterDirective,
} from "./reconnect-policy.js";

export type ReconnectExhaustionReason =
  | "attempts_exhausted"
  | "elapsed_budget_exhausted"
  | "retry_callback_rejected"
  | ReconnectDelayExhaustionReason;

export interface ReconnectTelemetry {
  readonly attempt: number;
  readonly chosenDelayMs: number | null;
  readonly directiveClassification: RetryAfterClassification;
  readonly directiveInvalidReason: RetryAfterInvalidReason | null;
  readonly exhaustionReason: ReconnectExhaustionReason | null;
  readonly remainingBudgetMs: number | null;
  readonly retryFloorMs: number;
}

export type ReconnectOutcome<T> =
  | { readonly kind: "ok"; readonly value: T; readonly attempts: number }
  | {
      readonly kind: "exhausted";
      readonly attempts: number;
      readonly lastError: unknown;
      readonly reason: ReconnectExhaustionReason;
      readonly telemetry: ReconnectTelemetry;
    }
  | {
      readonly kind: "aborted";
      readonly reason: "aborted";
      readonly attempts: number;
    };

export type ReconnectSleeper = (
  delayMs: number,
  signal: AbortSignal | undefined,
) => Promise<void>;

export interface ReconnectOpts<T> {
  readonly session: Session;
  readonly signal?: AbortSignal;
  /** Total provider calls, including the first attempt. */
  readonly maxAttempts?: number;
  /** Total elapsed retry window, including callbacks and sleeps. */
  readonly giveUpMs?: number;
  readonly rng?: () => number;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => number;
  readonly sleeper?: ReconnectSleeper;
  readonly attempt: (attempt: number) => Promise<T>;
  readonly isTransient: (err: unknown) => boolean;
  readonly onTransientRetry?: (
    attempt: number,
    err: unknown,
  ) => Promise<boolean> | boolean;
}

interface RetryWindowSnapshot {
  readonly elapsedMs: number;
  readonly remainingBudgetMs: number | undefined;
}

interface RetryWindow {
  snapshot(): RetryWindowSnapshot;
}

interface ExhaustedOutcomeInput {
  readonly attempts: number;
  readonly directive: RetryAfterDirective;
  readonly lastError: unknown;
  readonly reason: ReconnectExhaustionReason;
  readonly remainingBudgetMs: number | undefined;
  readonly session: Session;
}

/**
 * Read an adapter-produced directive from an error or its immediate wrapper.
 * Numeric compatibility fields are validated and never clamped.
 */
export function serverDirectedRetryAfter(err: unknown): RetryAfterDirective {
  const direct = retryAfterOnError(err);
  if (direct !== undefined) return direct;
  if (err !== null && typeof err === "object") {
    const wrapped = retryAfterOnError(
      (err as { readonly cause?: unknown }).cause,
    );
    if (wrapped !== undefined) return wrapped;
  }
  return classifyRetryAfterMilliseconds(undefined);
}

/**
 * Retry until success or a finite attempt/elapsed policy exhausts.
 *
 * At least one cap is mandatory. One immutable monotonic/wall start pair owns
 * the full call, so process suspension, callback work, and timer oversleep can
 * never restart or extend the ladder.
 */
export async function reconnectWithBackoff<T>(
  opts: ReconnectOpts<T>,
): Promise<ReconnectOutcome<T>> {
  const maxAttempts = optionalPositiveInteger(
    opts.maxAttempts,
    "maxAttempts",
  );
  const giveUpMs = optionalPositiveInteger(opts.giveUpMs, "giveUpMs");
  if (maxAttempts === undefined && giveUpMs === undefined) {
    throw new TypeError(
      "reconnectWithBackoff requires maxAttempts or giveUpMs",
    );
  }

  const retryWindow = createRetryWindow(
    opts.monotonicNow ?? monotonicMs,
    opts.wallNow ?? Date.now,
    giveUpMs,
  );
  const sleeper = opts.sleeper ?? abortableSleep;
  const rng = opts.rng ?? Math.random;
  let attempts = 0;
  let lastError: unknown = undefined;

  for (;;) {
    if (isReconnectAborted(opts.signal)) return aborted(attempts);
    const beforeAttempt = retryWindow.snapshot();
    if (budgetExhausted(beforeAttempt)) {
      return exhaustedOutcome({
        attempts,
        directive: { classification: "absent" },
        lastError,
        reason: "elapsed_budget_exhausted",
        remainingBudgetMs: beforeAttempt.remainingBudgetMs,
        session: opts.session,
      });
    }
    if (maxAttempts !== undefined && attempts >= maxAttempts) {
      return exhaustedOutcome({
        attempts,
        directive: { classification: "absent" },
        lastError,
        reason: "attempts_exhausted",
        remainingBudgetMs: beforeAttempt.remainingBudgetMs,
        session: opts.session,
      });
    }

    attempts += 1;
    let transientError: unknown;
    try {
      const value = await opts.attempt(attempts - 1);
      return { kind: "ok", value, attempts };
    } catch (err) {
      if (!opts.isTransient(err)) throw err;
      transientError = err;
      lastError = err;
    }

    if (isReconnectAborted(opts.signal)) return aborted(attempts);
    // Sample after the provider failure even though the failure callback must
    // still run for A1 cleanup/replay-safety classification before any delay
    // policy can win.
    retryWindow.snapshot();
    const directive = serverDirectedRetryAfter(transientError);
    if (isReconnectAborted(opts.signal)) return aborted(attempts);
    const callbackAccepted =
      (await opts.onTransientRetry?.(attempts, transientError)) !== false;
    if (isReconnectAborted(opts.signal)) return aborted(attempts);
    const afterCallback = retryWindow.snapshot();
    if (!callbackAccepted) {
      return exhaustedOutcome({
        attempts,
        directive,
        lastError,
        reason: "retry_callback_rejected",
        remainingBudgetMs: afterCallback.remainingBudgetMs,
        session: opts.session,
      });
    }
    if (budgetExhausted(afterCallback)) {
      return exhaustedOutcome({
        attempts,
        directive,
        lastError,
        reason: "elapsed_budget_exhausted",
        remainingBudgetMs: afterCallback.remainingBudgetMs,
        session: opts.session,
      });
    }
    if (maxAttempts !== undefined && attempts >= maxAttempts) {
      return exhaustedOutcome({
        attempts,
        directive,
        lastError,
        reason: "attempts_exhausted",
        remainingBudgetMs: afterCallback.remainingBudgetMs,
        session: opts.session,
      });
    }

    if (isReconnectAborted(opts.signal)) return aborted(attempts);
    const beforeSleep = retryWindow.snapshot();
    if (budgetExhausted(beforeSleep)) {
      return exhaustedOutcome({
        attempts,
        directive,
        lastError,
        reason: "elapsed_budget_exhausted",
        remainingBudgetMs: beforeSleep.remainingBudgetMs,
        session: opts.session,
      });
    }
    const delayDecision = calculateReconnectDelay({
      attempt: attempts - 1,
      baseDelayMs: RECONNECT_INITIAL_MS,
      maxDelayMs: RECONNECT_MAX_MS,
      remainingBudgetMs: beforeSleep.remainingBudgetMs,
      retryAfter: directive,
      rng,
    });
    if (delayDecision.kind === "exhausted") {
      return exhaustedFromDelayDecision(
        opts.session,
        attempts,
        lastError,
        delayDecision,
      );
    }

    emitScheduledRetry(opts.session, maxAttempts, delayDecision);
    if (isReconnectAborted(opts.signal)) return aborted(attempts);
    try {
      await sleeper(delayDecision.delayMs, opts.signal);
    } catch (error) {
      if (isReconnectAborted(opts.signal)) return aborted(attempts);
      throw error;
    }
    if (isReconnectAborted(opts.signal)) return aborted(attempts);
    const afterWake = retryWindow.snapshot();
    if (budgetExhausted(afterWake)) {
      return exhaustedOutcome({
        attempts,
        directive,
        lastError,
        reason: "elapsed_budget_exhausted",
        remainingBudgetMs: afterWake.remainingBudgetMs,
        session: opts.session,
      });
    }
  }
}

function retryAfterOnError(err: unknown): RetryAfterDirective | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const candidate = err as {
    readonly retryAfterDirective?: unknown;
    readonly retryAfterMs?: unknown;
  };
  if (candidate.retryAfterDirective !== undefined) {
    try {
      return validateRetryAfterDirective(
        candidate.retryAfterDirective as RetryAfterDirective,
      );
    } catch {
      return classifyRetryAfterMilliseconds(candidate.retryAfterDirective);
    }
  }
  if ("retryAfterMs" in candidate) {
    return classifyRetryAfterMilliseconds(candidate.retryAfterMs);
  }
  return undefined;
}

function createRetryWindow(
  monotonicNow: () => number,
  wallNow: () => number,
  giveUpMs: number | undefined,
): RetryWindow {
  const startedMonotonicMs = clockSample(monotonicNow(), "monotonicNow");
  const startedWallMs = clockSample(wallNow(), "wallNow");
  let maximumElapsedMs = 0;
  return Object.freeze({
    snapshot(): RetryWindowSnapshot {
      const monotonicElapsedMs = conservativeElapsed(
        startedMonotonicMs,
        clockSample(monotonicNow(), "monotonicNow"),
      );
      const wallElapsedMs = conservativeElapsed(
        startedWallMs,
        clockSample(wallNow(), "wallNow"),
      );
      maximumElapsedMs = Math.max(
        maximumElapsedMs,
        monotonicElapsedMs,
        wallElapsedMs,
      );
      return {
        elapsedMs: maximumElapsedMs,
        remainingBudgetMs:
          giveUpMs === undefined
            ? undefined
            : Math.max(0, giveUpMs - maximumElapsedMs),
      };
    },
  });
}

function conservativeElapsed(startedAtMs: number, currentMs: number): number {
  if (currentMs <= startedAtMs) return 0;
  const elapsed = currentMs - startedAtMs;
  if (!Number.isFinite(elapsed) || elapsed > Number.MAX_SAFE_INTEGER) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.ceil(elapsed);
}

function clockSample(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must return a finite number`);
  }
  return value;
}

function budgetExhausted(snapshot: RetryWindowSnapshot): boolean {
  return snapshot.remainingBudgetMs === 0;
}

function optionalPositiveInteger(
  value: number | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a finite safe positive integer`);
  }
  return value;
}

function aborted(attempts: number): ReconnectOutcome<never> {
  return { kind: "aborted", reason: "aborted", attempts };
}

function exhaustedFromDelayDecision(
  session: Session,
  attempts: number,
  lastError: unknown,
  decision: Extract<ReconnectDelayDecision, { readonly kind: "exhausted" }>,
): ReconnectOutcome<never> {
  return exhaustedOutcome({
    attempts,
    directive:
      decision.directiveClassification === "over_policy"
        ? {
            classification: "over_policy",
            floorMs: decision.retryFloorMs,
          }
        : {
            classification: "valid",
            floorMs: decision.retryFloorMs,
          },
    lastError,
    reason: decision.reason,
    remainingBudgetMs: decision.remainingBudgetMs ?? undefined,
    session,
  });
}

function exhaustedOutcome(
  input: ExhaustedOutcomeInput,
): ReconnectOutcome<never> {
  const telemetry = telemetryFor({
    attempt: input.attempts,
    chosenDelayMs: null,
    directive: input.directive,
    exhaustionReason: input.reason,
    remainingBudgetMs: input.remainingBudgetMs,
  });
  emitWarning(
    input.session.eventLog,
    input.session.nextInternalSubId(),
    "reconnect_exhausted",
    telemetryMessage(telemetry),
  );
  return {
    kind: "exhausted",
    attempts: input.attempts,
    lastError: input.lastError,
    reason: input.reason,
    telemetry,
  };
}

function emitScheduledRetry(
  session: Session,
  maxAttempts: number | undefined,
  decision: Extract<ReconnectDelayDecision, { readonly kind: "delay" }>,
): void {
  const telemetry = telemetryFor({
    attempt: decision.attempt + 1,
    chosenDelayMs: decision.delayMs,
    directive:
      decision.directiveClassification === "valid"
        ? { classification: "valid", floorMs: decision.retryFloorMs }
        : decision.directiveClassification === "invalid"
          ? {
              classification: "invalid",
              invalidReason: decision.directiveInvalidReason ?? "syntax",
            }
          : { classification: "absent" },
    exhaustionReason: null,
    remainingBudgetMs: decision.remainingBudgetMs ?? undefined,
  });
  emitWarning(
    session.eventLog,
    session.nextInternalSubId(),
    "reconnecting",
    `${telemetryMessage(telemetry)} maxAttempts=${maxAttempts ?? "elapsed"}`,
  );
}

function telemetryFor(input: {
  readonly attempt: number;
  readonly chosenDelayMs: number | null;
  readonly directive: RetryAfterDirective;
  readonly exhaustionReason: ReconnectExhaustionReason | null;
  readonly remainingBudgetMs: number | undefined;
}): ReconnectTelemetry {
  return Object.freeze({
    attempt: input.attempt,
    chosenDelayMs: input.chosenDelayMs,
    directiveClassification: input.directive.classification,
    directiveInvalidReason:
      input.directive.classification === "invalid"
        ? input.directive.invalidReason
        : null,
    exhaustionReason: input.exhaustionReason,
    remainingBudgetMs: input.remainingBudgetMs ?? null,
    retryFloorMs:
      input.directive.classification === "valid" ||
      input.directive.classification === "over_policy"
        ? input.directive.floorMs
        : 0,
  });
}

function telemetryMessage(telemetry: ReconnectTelemetry): string {
  return [
    `attempt=${telemetry.attempt}`,
    `delayMs=${telemetry.chosenDelayMs ?? "none"}`,
    `retryAfter=${telemetry.directiveClassification}`,
    `retryFloorMs=${telemetry.retryFloorMs}`,
    `remainingBudgetMs=${telemetry.remainingBudgetMs ?? "unbounded"}`,
    `exhaustion=${telemetry.exhaustionReason ?? "none"}`,
  ].join(" ");
}

function isReconnectAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortableSleep(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (delayMs <= 0 || signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    const timer = setTimeout(finish, delayMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
