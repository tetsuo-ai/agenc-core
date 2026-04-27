/**
 * Per-dir memory-type values stub for `runtime/src/llm/compact/**`.
 *
 * Mirrors `runtime/src/utils/memory/types.ts` so compact stays
 * resolvable after the AgenC `src/utils/memory/` tree is removed.
 *
 * The compact path only references the literal strings; the lean
 * runtime never feeds the team-mem variant in, so we keep the stable
 * subset here to avoid pulling `bun:bundle` feature flags into the
 * gut tree.
 */

export const MEMORY_TYPE_VALUES = [
  "User",
  "Project",
  "Local",
  "Managed",
  "AutoMem",
] as const;

export type MemoryType = (typeof MEMORY_TYPE_VALUES)[number];
