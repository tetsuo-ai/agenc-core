/**
 * Per-dir QuerySource stub for `runtime/src/llm/compact/**`.
 *
 * Mirrors the openclaude `runtime/src/constants/querySource.ts` stub so
 * compact stays resolvable after the umbrella `src/constants/` directory
 * is removed. Compact only uses this as a type-only reference, so a
 * permissive `any` alias is sufficient.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QuerySource = any;
