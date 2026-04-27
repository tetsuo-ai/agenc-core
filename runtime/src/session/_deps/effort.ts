/**
 * Per-dir EffortValue stub for `runtime/src/session/**`.
 *
 * Mirrors the AgenC `runtime/src/utils/effort.ts` reasoning-effort
 * tier. Carved as a local `_deps/` so the session tree stays
 * resolvable after the umbrella `src/utils/effort.ts` is removed.
 */

export type EffortValue = "minimal" | "low" | "medium" | "high" | "none";
