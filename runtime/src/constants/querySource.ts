/**
 * Ports OC `src/constants/querySource.ts` onto AgenC's runtime.
 *
 * Why this lives here / shape difference from upstream:
 *   - The donor snapshot exposes query sources as a permissive alias because
 *     the concrete source enum is outside that source slice.
 *
 * Cross-cuts deliberately NOT carried:
 *   - None; this file is type-only compatibility for query-source imports.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type QuerySource = any;
