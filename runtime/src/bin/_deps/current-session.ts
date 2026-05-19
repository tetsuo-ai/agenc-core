/**
 * Per-dir process-global "current runtime session" handle for
 * `runtime/src/bin/**`.
 *
 * Mirrors the AgenC implementation `runtime/src/utils/currentRuntimeSession.ts`
 * surface the bootstrap path consumes (`setCurrentRuntimeSession`,
 * `clearCurrentRuntimeSession`). Carved as a local `_deps/` to cut the
 * gut→AgenC crossing.
 *
 * The lean rebuild owns its own session lifecycle; the global slot is
 * preserved here only so compatibility bootstrap glue still has somewhere to
 * stash the active session reference.
 */

import type { Session } from "../../session/session.js";

let currentRuntimeSession: Session | null = null;

export function setCurrentRuntimeSession(session: Session | null): void {
  currentRuntimeSession = session;
}

export function clearCurrentRuntimeSession(session?: Session | null): void {
  if (session === undefined || currentRuntimeSession === session) {
    currentRuntimeSession = null;
  }
}
