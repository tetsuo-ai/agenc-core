/**
 * Per-dir tool-registry shape for `runtime/src/recovery/**`.
 *
 * Recovery only references `ToolDispatchResult` from the AgenC
 * `runtime/src/tool-registry.ts`. Carved as a local `_deps/` so the
 * gut recovery tree stays decoupled when the root tool-registry is
 * removed.
 */

export interface ToolDispatchResult {
  readonly content: string;
  readonly isError?: boolean;
  readonly metadata?: Record<string, unknown>;
}
