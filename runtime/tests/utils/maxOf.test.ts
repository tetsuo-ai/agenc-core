import { describe, expect, it } from "vitest";
import { maxOf } from "../../src/utils/maxOf.js";

// core-todo.md MarkdownTable.tsx:132/236/347 & StructuredDiff/Fallback.tsx:362:
// Math.max(...arr) spreads each element as a call argument, so a ~100k-line
// table/diff overflows the argument-count limit -> RangeError, crashing the
// render. maxOf reduces instead.

describe("maxOf", () => {
  it("handles arrays too large for Math.max(...spread) without a RangeError", () => {
    const big = Array.from({ length: 200_000 }, (_, i) => i);
    // The spread form is exactly what crashed the render:
    expect(() => Math.max(...big)).toThrow(RangeError);
    // The reduce form does not:
    expect(maxOf(big)).toBe(199_999);
  });

  it("respects the seed as a floor", () => {
    expect(maxOf([1, 2, 3], 10)).toBe(10);
    expect(maxOf([1, 2, 3], 0)).toBe(3);
    // Mirrors MarkdownTable's Math.max(...widths, MIN_COLUMN_WIDTH) intent.
    expect(maxOf([2, 5, 4], 3)).toBe(5);
  });

  it("returns the seed for an empty array (matching Math.max())", () => {
    expect(maxOf([], 5)).toBe(5);
    expect(maxOf([])).toBe(Number.NEGATIVE_INFINITY);
  });

  it("finds the max of a normal array", () => {
    expect(maxOf([3, 1, 4, 1, 5, 9, 2, 6])).toBe(9);
  });
});
