/** Pure reconnect delay and provider-floor policy. */

export const RECONNECT_INITIAL_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const RECONNECT_RETRY_AFTER_CEILING_MS = 300_000;

export type RetryAfterClassification =
  | "absent"
  | "invalid"
  | "valid"
  | "over_policy";

export type RetryAfterInvalidReason =
  | "negative"
  | "non_finite"
  | "overflow"
  | "syntax";

export type RetryAfterDirective =
  | { readonly classification: "absent" }
  | {
      readonly classification: "invalid";
      readonly invalidReason: RetryAfterInvalidReason;
    }
  | { readonly classification: "valid"; readonly floorMs: number }
  | { readonly classification: "over_policy"; readonly floorMs: number };

export type ReconnectDelayExhaustionReason =
  | "retry_after_exceeds_policy"
  | "retry_after_exceeds_budget";

interface ReconnectDelayDecisionBase {
  readonly attempt: number;
  readonly directiveClassification: RetryAfterClassification;
  readonly directiveInvalidReason: RetryAfterInvalidReason | null;
  readonly exponentialCapMs: number;
  readonly remainingBudgetMs: number | null;
  readonly retryFloorMs: number;
}

export interface ReconnectDelayScheduled
  extends ReconnectDelayDecisionBase {
  readonly kind: "delay";
  readonly delayMs: number;
  readonly jitterCapMs: number;
}

export interface ReconnectDelayExhausted
  extends ReconnectDelayDecisionBase {
  readonly kind: "exhausted";
  readonly reason: ReconnectDelayExhaustionReason;
}

export type ReconnectDelayDecision =
  | ReconnectDelayScheduled
  | ReconnectDelayExhausted;

export interface ReconnectDelayInput {
  readonly attempt: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly remainingBudgetMs: number | undefined;
  readonly retryAfter: RetryAfterDirective;
  readonly rng: () => number;
}

const MAX_INCLUSIVE_JITTER_CAP_MS = Number.MAX_SAFE_INTEGER - 1;
const FIRST_SATURATING_BINARY_EXPONENT = 53;
const ABSENT_RETRY_AFTER = Object.freeze({
  classification: "absent",
} as const satisfies RetryAfterDirective);

/**
 * Validate an already-parsed provider millisecond value without shortening it.
 * Raw Retry-After header parsing remains in the HTTP adapter.
 */
export function classifyRetryAfterMilliseconds(
  value: unknown,
): RetryAfterDirective {
  if (value === undefined) return ABSENT_RETRY_AFTER;
  if (typeof value !== "number") {
    return invalidDirective("syntax");
  }
  if (!Number.isFinite(value)) {
    return invalidDirective("non_finite");
  }
  if (value < 0) {
    return invalidDirective("negative");
  }
  if (!Number.isSafeInteger(value)) {
    return invalidDirective(
      Math.abs(value) > Number.MAX_SAFE_INTEGER ? "overflow" : "syntax",
    );
  }
  if (value > RECONNECT_RETRY_AFTER_CEILING_MS) {
    return Object.freeze({ classification: "over_policy", floorMs: value });
  }
  return Object.freeze({ classification: "valid", floorMs: value });
}

/**
 * Compute a bounded full-jitter delay in O(1).
 *
 * The random source is sampled exactly once only when a delay can be
 * scheduled. Provider floors are additive: the random component is drawn from
 * the exponential window remaining after all finite budgets are applied.
 */
export function calculateReconnectDelay(
  input: ReconnectDelayInput,
): ReconnectDelayDecision {
  const attempt = safeNonnegativeInteger(input.attempt, "attempt");
  const baseDelayMs = safePositiveInteger(input.baseDelayMs, "baseDelayMs");
  const maxDelayMs = safePositiveInteger(input.maxDelayMs, "maxDelayMs");
  if (maxDelayMs > MAX_INCLUSIVE_JITTER_CAP_MS) {
    throw new TypeError(
      `maxDelayMs must not exceed ${MAX_INCLUSIVE_JITTER_CAP_MS}`,
    );
  }
  const remainingBudgetMs =
    input.remainingBudgetMs === undefined
      ? undefined
      : safeNonnegativeInteger(
          input.remainingBudgetMs,
          "remainingBudgetMs",
        );
  const retryAfter = validateRetryAfterDirective(input.retryAfter);
  const exponentialCapMs = saturatingExponentialCapMs(
    baseDelayMs,
    maxDelayMs,
    attempt,
  );
  const decisionBase = {
    attempt,
    directiveClassification: retryAfter.classification,
    directiveInvalidReason:
      retryAfter.classification === "invalid"
        ? retryAfter.invalidReason
        : null,
    exponentialCapMs,
    remainingBudgetMs: remainingBudgetMs ?? null,
    retryFloorMs:
      retryAfter.classification === "valid" ||
      retryAfter.classification === "over_policy"
        ? retryAfter.floorMs
        : 0,
  } as const;

  if (retryAfter.classification === "over_policy") {
    return {
      ...decisionBase,
      kind: "exhausted",
      reason: "retry_after_exceeds_policy",
    };
  }

  const retryFloorMs = decisionBase.retryFloorMs;
  if (
    remainingBudgetMs !== undefined &&
    retryFloorMs > remainingBudgetMs
  ) {
    return {
      ...decisionBase,
      kind: "exhausted",
      reason: "retry_after_exceeds_budget",
    };
  }

  const budgetJitterCapMs =
    remainingBudgetMs === undefined
      ? MAX_INCLUSIVE_JITTER_CAP_MS
      : remainingBudgetMs - retryFloorMs;
  const arithmeticJitterCapMs =
    Number.MAX_SAFE_INTEGER - retryFloorMs;
  const jitterCapMs = Math.min(
    exponentialCapMs,
    budgetJitterCapMs,
    arithmeticJitterCapMs,
  );
  const random = input.rng();
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new TypeError("rng must return a finite value in [0, 1)");
  }
  const jitterMs = Math.floor(random * (jitterCapMs + 1));
  return {
    ...decisionBase,
    kind: "delay",
    delayMs: retryFloorMs + jitterMs,
    jitterCapMs,
  };
}

function saturatingExponentialCapMs(
  baseDelayMs: number,
  maxDelayMs: number,
  attempt: number,
): number {
  if (baseDelayMs >= maxDelayMs) return maxDelayMs;
  if (attempt >= FIRST_SATURATING_BINARY_EXPONENT) return maxDelayMs;
  const factor = 2 ** attempt;
  if (baseDelayMs > Math.floor(maxDelayMs / factor)) return maxDelayMs;
  return baseDelayMs * factor;
}

export function validateRetryAfterDirective(
  value: RetryAfterDirective,
): RetryAfterDirective {
  if (value === null || typeof value !== "object") {
    throw new TypeError("retryAfter must be a validated directive");
  }
  switch (value.classification) {
    case "absent":
      return ABSENT_RETRY_AFTER;
    case "invalid":
      if (
        value.invalidReason !== "negative" &&
        value.invalidReason !== "non_finite" &&
        value.invalidReason !== "overflow" &&
        value.invalidReason !== "syntax"
      ) {
        throw new TypeError("retryAfter has an invalid reason code");
      }
      return Object.freeze({
        classification: "invalid",
        invalidReason: value.invalidReason,
      });
    case "valid": {
      const floorMs = safeNonnegativeInteger(value.floorMs, "retryFloorMs");
      if (floorMs > RECONNECT_RETRY_AFTER_CEILING_MS) {
        throw new TypeError("valid retryAfter exceeds the policy ceiling");
      }
      return Object.freeze({ classification: "valid", floorMs });
    }
    case "over_policy": {
      const floorMs = safeNonnegativeInteger(value.floorMs, "retryFloorMs");
      if (floorMs <= RECONNECT_RETRY_AFTER_CEILING_MS) {
        throw new TypeError("over-policy retryAfter does not exceed the ceiling");
      }
      return Object.freeze({ classification: "over_policy", floorMs });
    }
    default:
      throw new TypeError("retryAfter has an unknown classification");
  }
}

function invalidDirective(
  invalidReason: RetryAfterInvalidReason,
): RetryAfterDirective {
  return Object.freeze({ classification: "invalid", invalidReason });
}

function safePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a finite safe positive integer`);
  }
  return value;
}

function safeNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a finite safe nonnegative integer`);
  }
  return value;
}
