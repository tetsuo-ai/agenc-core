/**
 * Per-dir QuerySource stub for `runtime/src/session/**`.
 *
 * Mirrors the openclaude `runtime/src/constants/querySource.ts` stub so
 * the session path stays resolvable after the umbrella `src/constants/`
 * directory is removed. Session only uses this as a type-only reference,
 * so a permissive `any` alias is sufficient.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QuerySource = any;
