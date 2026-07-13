/**
 * Reduce-based maximum. Unlike `Math.max(...values)`, this does not spread the
 * array into call arguments, so it cannot throw `RangeError: Maximum call stack
 * size exceeded` on a large array (a ~100k-line markdown table or diff would
 * crash the render otherwise).
 *
 * @param values numbers to reduce
 * @param seed floor / initial value (default -Infinity, matching `Math.max()`)
 */
export function maxOf(
  values: readonly number[],
  seed: number = Number.NEGATIVE_INFINITY,
): number {
  let max = seed;
  for (const value of values) {
    if (value > max) max = value;
  }
  return max;
}
