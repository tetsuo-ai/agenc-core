/**
 * Per-dir monotonic clock helper for `runtime/src/agents/**`.
 *
 * Mirrors the AgenC implementation `runtime/src/utils/monotonic.ts` API the
 * agent-status tracker uses. Carved as a local `_deps/` to cut the
 * gut→AgenC crossing.
 */

export function monotonicMs(): number {
  return performance.now();
}
