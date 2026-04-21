// @ts-nocheck
// Stub for openclaude's `src/utils/attributionHooks.ts`, which is conditionally
// loaded via `feature('COMMIT_ATTRIBUTION')` in the compact module but never
// ships in upstream source. The feature flag resolves to `false` in AgenC via
// the `bun:bundle` shim, so this module is dead code at runtime. The stub
// exists only to keep the dynamic import type-resolvable.
export function sweepFileContentCache(): void {}
