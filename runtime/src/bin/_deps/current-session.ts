/**
 * Per-dir process-global "current runtime session" handle for
 * `runtime/src/bin/**`.
 *
 * Mirrors the AgenC implementation `runtime/src/utils/currentRuntimeSession.ts`
 * surface the bootstrap path consumes (`setCurrentRuntimeSession`,
 * `clearCurrentRuntimeSession`). Carved as a local `_deps/` to cut the
 * legacy bootstrap crossing.
 *
 * The lean rebuild owns its own session lifecycle; the global slot is
 * preserved here only so compatibility bootstrap glue still has somewhere to
 * stash the active session reference.
 */

export {
  clearCurrentRuntimeSession,
  getCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "../../session/current-session.js";
