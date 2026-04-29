/**
 * Per-dir filesystem-tool argument key constants for
 * `runtime/src/agents/**`.
 *
 * The agent run-loop injects two non-enumerable args into every child
 * tool call so the AgenC implementation filesystem tools can scope their
 * I/O:
 *   - `__agencSessionId` — the child conversation id
 *   - `__agencSessionAllowedRoots` — extra workspace roots for the
 *     child (worktree path)
 *
 * Carved as a local `_deps/` (mirroring
 * `runtime/src/tools/system/filesystem.ts`) to cut the gut→AgenC
 * crossing without re-importing the full filesystem tool surface.
 */

export const SESSION_ID_ARG = "__agencSessionId";
export const SESSION_ALLOWED_ROOTS_ARG = "__agencSessionAllowedRoots";
