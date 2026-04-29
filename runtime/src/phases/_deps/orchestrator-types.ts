/**
 * Per-dir orchestrator type stubs for `runtime/src/phases/**`.
 *
 * Phases forward approval and sandbox policy into the lean
 * `_deps/tool-runtime.ts` executor. These aliases now point at the
 * canonical in-tree orchestrator port so the live executor and phase
 * seam agree on AgenC-style policy spellings.
 */

export type {
  ApprovalPolicy,
  ApprovalResolver,
  PermissionRequestHook,
  SandboxMode,
} from "../../tools/orchestrator.js";

// Streaming executor type used by phases/post-sample-recovery and
// recovery/* — they only receive an instance and call
// `.tombstoneInFlightToolCalls()` / `.cancel()` on it. Permissive any
// keeps the gut tree decoupled from the deleted AgenC class.
export type StreamingToolExecutor = any;
