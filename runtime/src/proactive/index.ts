// @ts-nocheck
// Stub for openclaude's `src/proactive/index.ts`, which is conditionally
// loaded via `feature('SELF_DIRECTED')` in the compact module but never ships
// in upstream source. The feature flag resolves to `false` in AgenC via the
// `bun:bundle` shim, so this module is dead code at runtime. The stub exists
// only to keep `require('../../proactive/index.js')` type-resolvable.
export function isProactiveActive(): boolean {
  return false;
}
