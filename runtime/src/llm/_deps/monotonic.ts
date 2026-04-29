/**
 * Local _deps stub for the gut/AgenC crossing of `../utils/monotonic.js`.
 * Minimal monotonic-clock helpers used by stream-watchdog and grok adapter.
 */

export function monotonicMs(): number {
  return performance.now();
}

export function monotonicNs(): bigint {
  return process.hrtime.bigint();
}

export function startElapsedMs(): () => number {
  const start = performance.now();
  return () => performance.now() - start;
}
