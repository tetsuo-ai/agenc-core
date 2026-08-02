import { describe, expect, test, vi } from "vitest";

import {
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  RECONNECT_RETRY_AFTER_CEILING_MS,
  calculateReconnectDelay,
  classifyRetryAfterMilliseconds,
  type RetryAfterDirective,
} from "../../src/recovery/reconnect-policy.js";
import {
  createSeededRng,
  createSequenceRng,
} from "../helpers/seeded-rng.js";

const ABSENT = Object.freeze({
  classification: "absent",
} as const satisfies RetryAfterDirective);
const LAST_EXACT_BINARY_FACTOR = 2 ** 52;

function calculate(
  rng: () => number,
  overrides: Partial<Parameters<typeof calculateReconnectDelay>[0]> = {},
) {
  return calculateReconnectDelay({
    attempt: 0,
    baseDelayMs: RECONNECT_INITIAL_MS,
    maxDelayMs: RECONNECT_MAX_MS,
    remainingBudgetMs: undefined,
    retryAfter: ABSENT,
    rng,
    ...overrides,
  });
}

describe("calculateReconnectDelay", () => {
  test("uses exact full-jitter lower, midpoint, and inclusive upper boundaries", () => {
    const sequence = createSequenceRng(
      [0, 0.5, 1 - Number.EPSILON],
      "E2 exact jitter boundaries",
    );

    expect(calculate(() => sequence.nextFloat())).toMatchObject({
      kind: "delay",
      delayMs: 0,
      exponentialCapMs: 1_000,
      jitterCapMs: 1_000,
    });
    expect(calculate(() => sequence.nextFloat())).toMatchObject({
      kind: "delay",
      delayMs: 500,
    });
    expect(calculate(() => sequence.nextFloat())).toMatchObject({
      kind: "delay",
      delayMs: 1_000,
    });
    sequence.assertConsumed();
  });

  test("saturates exponential arithmetic for very large attempts", () => {
    expect(
      calculate(() => 1 - Number.EPSILON, {
        attempt: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({
      kind: "delay",
      delayMs: RECONNECT_MAX_MS,
      exponentialCapMs: RECONNECT_MAX_MS,
    });
  });

  test("keeps the last safe binary boundary exact before saturation", () => {
    const maxDelayMs = LAST_EXACT_BINARY_FACTOR + 1;
    expect(
      calculate(() => 0, {
        attempt: 52,
        baseDelayMs: 1,
        maxDelayMs,
      }),
    ).toMatchObject({ exponentialCapMs: LAST_EXACT_BINARY_FACTOR });
    expect(
      calculate(() => 0, {
        attempt: 53,
        baseDelayMs: 1,
        maxDelayMs,
      }),
    ).toMatchObject({ exponentialCapMs: maxDelayMs });
    expect(
      calculate(() => 0, {
        attempt: 52,
        baseDelayMs: 2,
        maxDelayMs,
      }),
    ).toMatchObject({ exponentialCapMs: maxDelayMs });
  });

  test("treats a valid directive as a floor plus additional jitter", () => {
    expect(
      calculate(() => 0.5, {
        retryAfter: { classification: "valid", floorMs: 5_000 },
      }),
    ).toMatchObject({
      kind: "delay",
      delayMs: 5_500,
      retryFloorMs: 5_000,
      jitterCapMs: 1_000,
    });
  });

  test("bounds additional jitter by the remaining elapsed budget", () => {
    expect(
      calculate(() => 1 - Number.EPSILON, {
        remainingBudgetMs: 5_500,
        retryAfter: { classification: "valid", floorMs: 5_000 },
      }),
    ).toMatchObject({
      kind: "delay",
      delayMs: 5_500,
      jitterCapMs: 500,
      remainingBudgetMs: 5_500,
    });
  });

  test("exhausts valid floors above policy or remaining budget without drawing RNG", () => {
    const rng = vi.fn(() => 0.5);
    expect(
      calculate(rng, {
        retryAfter: {
          classification: "over_policy",
          floorMs: RECONNECT_RETRY_AFTER_CEILING_MS + 1,
        },
      }),
    ).toMatchObject({
      kind: "exhausted",
      reason: "retry_after_exceeds_policy",
    });
    expect(
      calculate(rng, {
        remainingBudgetMs: 4_999,
        retryAfter: { classification: "valid", floorMs: 5_000 },
      }),
    ).toMatchObject({
      kind: "exhausted",
      reason: "retry_after_exceeds_budget",
    });
    expect(rng).not.toHaveBeenCalled();
  });

  test("invalid directives fall back to ordinary full jitter", () => {
    expect(
      calculate(() => 0.25, {
        retryAfter: {
          classification: "invalid",
          invalidReason: "non_finite",
        },
      }),
    ).toMatchObject({
      kind: "delay",
      delayMs: 250,
      retryFloorMs: 0,
      directiveClassification: "invalid",
    });
  });

  test.each([Number.NaN, Number.NEGATIVE_INFINITY, -0.01, 1, 2])(
    "rejects RNG output outside finite [0, 1): %s",
    (value) => {
      expect(() => calculate(() => value)).toThrowError(/finite.*\[0, 1\)/u);
    },
  );

  test("validates numeric directives without clamping", () => {
    expect(classifyRetryAfterMilliseconds(undefined)).toEqual({
      classification: "absent",
    });
    expect(classifyRetryAfterMilliseconds(-1)).toEqual({
      classification: "invalid",
      invalidReason: "negative",
    });
    expect(classifyRetryAfterMilliseconds(Number.POSITIVE_INFINITY)).toEqual({
      classification: "invalid",
      invalidReason: "non_finite",
    });
    expect(classifyRetryAfterMilliseconds(Number.MAX_SAFE_INTEGER + 1)).toEqual({
      classification: "invalid",
      invalidReason: "overflow",
    });
    expect(
      classifyRetryAfterMilliseconds(
        RECONNECT_RETRY_AFTER_CEILING_MS + 1,
      ),
    ).toEqual({
      classification: "over_policy",
      floorMs: RECONNECT_RETRY_AFTER_CEILING_MS + 1,
    });
  });

  test("seeded samples stay bounded and occupy every broad full-jitter bucket", () => {
    const rng = createSeededRng({
      domain: "E2 full-jitter distribution v1",
      seed: "fixed-reconnect-seed",
    });
    const buckets = new Array<number>(10).fill(0);
    const samples = 20_000;
    for (let index = 0; index < samples; index += 1) {
      const decision = calculate(() => rng.nextFloat(), { attempt: 5 });
      expect(decision.kind).toBe("delay");
      if (decision.kind !== "delay") continue;
      expect(decision.delayMs).toBeGreaterThanOrEqual(0);
      expect(decision.delayMs).toBeLessThanOrEqual(RECONNECT_MAX_MS);
      const bucket = Math.min(
        buckets.length - 1,
        Math.floor((decision.delayMs / (RECONNECT_MAX_MS + 1)) * buckets.length),
      );
      buckets[bucket] += 1;
    }
    for (const occupancy of buckets) {
      expect(occupancy).toBeGreaterThan(samples * 0.07);
    }
  });
});
