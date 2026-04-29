/**
 * Monotonic clock helper.
 *
 * I-82 (docs/plan/invariants.md): every deadline / elapsed-time
 * calculation MUST use this, not `Date.now()`. Wall clock is reserved
 * for display + event-log timestamps. NTP corrections, manual `date`
 * sets, suspend/resume, and container clock skew all break wall-clock
 * arithmetic; the monotonic clock is immune.
 *
 * @module
 */

/**
 * Monotonically non-decreasing milliseconds since process start.
 *
 * Wraps `performance.now()` so that callers don't need to import the
 * Node performance hooks every time. Returns a `number` (not `bigint`)
 * for ergonomics; sub-millisecond precision is preserved as a fraction.
 *
 * Use this for I-9 tool timeouts, I-11 stream watchdog, I-22 mid-stream
 * budget checks, OAuth refresh backoff, SDK retry timing, and anywhere
 * else AgenC computes "did N ms elapse?".
 */
export function monotonicMs(): number {
  return performance.now();
}

/**
 * High-resolution monotonic nanoseconds via `process.hrtime.bigint()`.
 *
 * Use only when sub-millisecond precision actually matters (e.g.
 * micro-benchmarks, fine-grained tracing). For everything else,
 * `monotonicMs()` is the right choice.
 */
export function monotonicNs(): bigint {
  return process.hrtime.bigint();
}

/**
 * Returns a function that, on each call, reports milliseconds elapsed
 * since the helper was constructed.
 *
 * ```ts
 * const elapsed = startElapsedMs();
 * await doWork();
 * console.log(`took ${elapsed()}ms`);
 * ```
 */
export function startElapsedMs(): () => number {
  const start = performance.now();
  return () => performance.now() - start;
}
