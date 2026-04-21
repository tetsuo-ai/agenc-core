import type { Session } from "../session/session.js";

let currentRuntimeSession: Session | null = null;

export function setCurrentRuntimeSession(session: Session | null): void {
  currentRuntimeSession = session;
}

export function getCurrentRuntimeSession(): Session | null {
  return currentRuntimeSession;
}

export function clearCurrentRuntimeSession(session?: Session | null): void {
  if (session === undefined || currentRuntimeSession === session) {
    currentRuntimeSession = null;
  }
}

export function requireCurrentRuntimeSession(): Session {
  if (currentRuntimeSession === null) {
    throw new Error("codex runtime session is not initialized");
  }
  return currentRuntimeSession;
}
