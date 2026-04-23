/**
 * Per-dir orchestrator type stubs for `runtime/src/session/**`.
 *
 * Session only references these as type-only parameters; permissive
 * `any`-typed aliases are sufficient. Carved as a local `_deps/` so
 * the gut session tree stays resolvable after the openclaude
 * `tools/orchestrator.ts` is removed.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ApprovalResolver = any;
export type PermissionRequestHook = any;
