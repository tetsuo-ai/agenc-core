/**
 * Lean monotonic-clock helper for the recovery subsystem.
 *
 * Mirrors the surface `recovery/reconnection.ts` actually uses:
 * `monotonicMs()` returns monotonically non-decreasing milliseconds
 * since process start, immune to wall-clock corrections.
 */

export function monotonicMs(): number {
  return performance.now();
}
