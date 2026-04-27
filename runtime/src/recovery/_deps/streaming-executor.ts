/**
 * Per-dir StreamingToolExecutor stub for `runtime/src/recovery/**`.
 *
 * Recovery callers only forward an executor instance through as a
 * type-only parameter (and call `.tombstoneInFlightToolCalls()` /
 * `.cancel()` on it). Carved as a local `_deps/` so the gut recovery
 * path stays decoupled from the deleted AgenC class.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StreamingToolExecutor = any;
