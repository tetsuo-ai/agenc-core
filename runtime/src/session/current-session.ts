import { AsyncLocalStorage } from "node:async_hooks";
import type { Session } from "./session.js";

const scopedRuntimeSession = new AsyncLocalStorage<Session>();
let currentRuntimeSession: Session | null = null;

/**
 * Sessions that have been registered as the process-wide fallback via
 * `setCurrentRuntimeSession`. Each bootstrap registers its session here;
 * once MORE THAN ONE session is live in the process, the module-level
 * fallback is ambiguous (it always points at the LAST bootstrapped
 * session), so `getCurrentRuntimeSession` refuses to guess and throws
 * outside an AsyncLocalStorage scope instead of silently returning the
 * wrong session. Single-session processes (CLI one-shots, tests) keep
 * the fallback behavior.
 */
let trackedFallbackSessions = new WeakSet<Session>();
let liveFallbackSessionCount = 0;

export function setCurrentRuntimeSession(session: Session | null): void {
  if (session !== null && !trackedFallbackSessions.has(session)) {
    trackedFallbackSessions.add(session);
    liveFallbackSessionCount += 1;
  }
  currentRuntimeSession = session;
}

export function getCurrentRuntimeSession(): Session | null {
  const scoped = scopedRuntimeSession.getStore();
  if (scoped !== undefined) return scoped;
  if (liveFallbackSessionCount > 1) {
    throw new Error(
      `Ambiguous runtime session: ${liveFallbackSessionCount} sessions are ` +
        "bootstrapped in this process and no session is bound to the current " +
        "async context. The module-level fallback would return whichever " +
        "session bootstrapped last, which may be the wrong one. Access the " +
        "session inside a turn (runWithCurrentRuntimeSession scope) or pass " +
        "it explicitly.",
    );
  }
  return currentRuntimeSession;
}

/**
 * Non-throwing variant for best-effort consumers (e.g. lifecycle hook
 * dispatch): returns the AsyncLocalStorage-scoped session when inside a
 * turn, the module-level fallback when it is unambiguous (at most one
 * live session), and `null` otherwise.
 */
export function peekAmbientRuntimeSession(): Session | null {
  const scoped = scopedRuntimeSession.getStore();
  if (scoped !== undefined) return scoped;
  return liveFallbackSessionCount > 1 ? null : currentRuntimeSession;
}

export function requireCurrentRuntimeSession(label: string): Session {
  const session = getCurrentRuntimeSession();
  if (!session) {
    throw new Error(`No active runtime session for ${label}`);
  }
  return session;
}

export function clearCurrentRuntimeSession(session?: Session | null): void {
  if (session === undefined) {
    // Full reset (test cleanup / process teardown): drop the fallback AND
    // the ambiguity tracking so the next bootstrap starts unambiguous.
    trackedFallbackSessions = new WeakSet<Session>();
    liveFallbackSessionCount = 0;
    currentRuntimeSession = null;
    return;
  }
  if (session !== null && trackedFallbackSessions.has(session)) {
    trackedFallbackSessions.delete(session);
    liveFallbackSessionCount = Math.max(0, liveFallbackSessionCount - 1);
  }
  if (currentRuntimeSession === session) {
    currentRuntimeSession = null;
  }
}

export function runWithCurrentRuntimeSession<T>(
  session: Session,
  fn: () => T,
): T {
  return scopedRuntimeSession.run(session, fn);
}
