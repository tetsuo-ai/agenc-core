import { describe, expect, it } from "vitest";

import {
  ExecutionAdmissionStateError,
  NANO_USD_PER_USD,
  nanosToUsd,
  usdToNanos,
} from "../../src/state/execution-admission.js";

describe("usdToNanos", () => {
  it.each([
    [0, 0],
    [1, NANO_USD_PER_USD],
    [0.1, 100_000_000],
    [0.003, 3_000_000],
    [0.00995, 9_950_000],
  ] as const)("converts %s from its decimal spelling, not binary float", (usd, nanos) => {
    expect(usdToNanos(usd)).toBe(nanos);
    expect(usdToNanos(nanosToUsd(nanos))).toBe(nanos);
  });

  it("treats -0 as zero and ceils a sub-nano remainder", () => {
    expect(usdToNanos(-0)).toBe(0);
    expect(usdToNanos(1e-10)).toBe(1);
    expect(usdToNanos(1.5e-9)).toBe(2);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite or negative USD %s",
    (value) => {
      expect(() => usdToNanos(value)).toThrow(ExecutionAdmissionStateError);
      expect(() => usdToNanos(value)).toThrow("finite non-negative");
    },
  );

  it("rejects a value that cannot fit in a safe nano-USD integer", () => {
    expect(() => usdToNanos(Number.MAX_SAFE_INTEGER)).toThrow("safe nano-USD range");
  });
});

describe("nanosToUsd", () => {
  it("divides by the nano scale without inventing extra nanos on the reverse trip", () => {
    expect(nanosToUsd(3_000_000)).toBe(0.003);
    expect(nanosToUsd(usdToNanos(0.003))).toBe(0.003);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid nano-USD %s",
    (value) => {
      expect(() => nanosToUsd(value)).toThrow(ExecutionAdmissionStateError);
      expect(() => nanosToUsd(value)).toThrow("non-negative safe integer");
    },
  );
});
