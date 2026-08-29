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
const trackedFallbackSessions = new Set<Session>();

/**
 * Marks the async span of a bootstrap that has not created its session
 * yet. Inside it, an ambient-session read legitimately means "this
 * chain has no session" — construction code (tool registries, env
 * defaults) must fall back to startup authority, never guess between
 * OTHER sessions that happen to be live in the daemon. Outside it, an
 * ambiguous unscoped read is still a hard error: silently picking a
 * session there could hand one session's turn another session's
 * provider credentials.
 */
const bootstrapWithoutSessionScope = new AsyncLocalStorage<true>();

/** Return only the session bound to the current async execution context. */
export function peekScopedRuntimeSession(): Session | null {
  return scopedRuntimeSession.getStore() ?? null;
}

export function setCurrentRuntimeSession(session: Session | null): void {
  if (session !== null) trackedFallbackSessions.add(session);
  currentRuntimeSession = session;
}

export function getCurrentRuntimeSession(): Session | null {
  const scoped = scopedRuntimeSession.getStore();
  if (scoped !== undefined) return scoped;
  if (trackedFallbackSessions.size > 1) {
    // A bootstrap that has not created its session yet has a defined
    // answer — "none" — regardless of how many OTHER sessions are
    // live. Falling through to null routes construction-time reads to
    // startup authority instead of a guess.
    if (bootstrapWithoutSessionScope.getStore() === true) return null;
    throw new Error(
      `Ambiguous runtime session: ${trackedFallbackSessions.size} sessions are ` +
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
  return trackedFallbackSessions.size > 1 ? null : currentRuntimeSession;
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
    trackedFallbackSessions.clear();
    currentRuntimeSession = null;
    return;
  }
  if (session !== null) trackedFallbackSessions.delete(session);
  if (currentRuntimeSession === session) {
    currentRuntimeSession =
      trackedFallbackSessions.values().next().value ?? null;
  }
}

export function runWithCurrentRuntimeSession<T>(
  session: Session,
  fn: () => T,
): T {
  return scopedRuntimeSession.run(session, fn);
}

/**
 * Bind `session` to the CURRENT async execution context and its
 * descendants. Bootstrap needs this shape: the session is created in
 * the middle of a long async flow whose tail keeps resolving the
 * ambient session, and in a multi-session daemon the module-level
 * fallback is (correctly) refused once a second session is live. A
 * `run()` wrapper would mean restructuring the whole tail; `enterWith`
 * scopes the continuation in place. Callers outside this async chain
 * are unaffected.
 */
export function enterCurrentRuntimeSessionScope(session: Session): void {
  scopedRuntimeSession.enterWith(session);
}

/**
 * Run `fn` marked as a pre-session bootstrap span: ambient-session
 * reads inside it resolve to "none" instead of throwing when other
 * sessions are live. Once the bootstrap creates its session it binds
 * it with {@link enterCurrentRuntimeSessionScope}, which wins over
 * this marker for the rest of the chain.
 */
export function runWithBootstrapSessionScope<T>(fn: () => T): T {
  return bootstrapWithoutSessionScope.run(true, fn);
}
