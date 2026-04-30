/**
 * Per-dir QuerySource stub for `runtime/src/phases/**`.
 *
 * Mirrors the agenc `runtime/src/constants/querySource.ts` stub so
 * the phases path stays resolvable after the umbrella `src/constants/`
 * directory is removed. Phases only uses this as a type-only reference,
 * so a permissive `any` alias is sufficient.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QuerySource = any;
