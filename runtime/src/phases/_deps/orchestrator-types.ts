/**
 * Per-dir orchestrator type stubs for `runtime/src/phases/**`.
 *
 * Phases only forwards these as type-only parameters to the lean
 * `_deps/tool-runtime.ts` stubs; permissive `any`-typed aliases are
 * sufficient here. Carved as a local `_deps/` so gut phases stay
 * resolvable after the openclaude `tools/orchestrator.ts` is removed.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ApprovalPolicy = any;
export type ApprovalResolver = any;
export type PermissionRequestHook = any;
export type SandboxMode =
  | "danger-full-access"
  | "read-only"
  | "workspace-write"
  | "no-network";

// Streaming executor type used by phases/post-sample-recovery and
// recovery/* — they only receive an instance and call
// `.tombstoneInFlightToolCalls()` / `.cancel()` on it. Permissive any
// keeps the gut tree decoupled from the deleted openclaude class.
export type StreamingToolExecutor = any;
