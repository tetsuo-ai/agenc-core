import { AsyncLocalStorage } from "node:async_hooks";
import type { Session } from "./session.js";

const scopedRuntimeSession = new AsyncLocalStorage<Session>();
let currentRuntimeSession: Session | null = null;

export function setCurrentRuntimeSession(session: Session | null): void {
  currentRuntimeSession = session;
}

export function getCurrentRuntimeSession(): Session | null {
  return scopedRuntimeSession.getStore() ?? currentRuntimeSession;
}

export function requireCurrentRuntimeSession(label: string): Session {
  const session = getCurrentRuntimeSession();
  if (!session) {
    throw new Error(`No active runtime session for ${label}`);
  }
  return session;
}

export function clearCurrentRuntimeSession(session?: Session | null): void {
  if (session === undefined || currentRuntimeSession === session) {
    currentRuntimeSession = null;
  }
}

export function runWithCurrentRuntimeSession<T>(
  session: Session,
  fn: () => T,
): T {
  return scopedRuntimeSession.run(session, fn);
}
