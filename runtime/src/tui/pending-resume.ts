/**
 * Cross-boundary handoff for the in-session `/resume` picker.
 *
 * The daemon-backed TUI captures its session immutably at boot
 * (`main.tsx` renders `<AgenCTuiApp session=… />` with a fixed prop), so
 * the picker cannot swap the live session inside the running Ink tree.
 * Instead, selecting an entry records the chosen session id here and asks
 * the app to exit cleanly. After `waitUntilExit()` drains Ink and the
 * prior session is detached, the boot entrypoint in `bin/agenc.ts`
 * consumes this id and re-enters the proven `resumeTUIEntry` attach path
 * (which rehydrates the chosen session — including cold rollouts — and
 * rebuilds the daemon bridge correctly).
 *
 * A module-level slot is intentional: it survives the Ink unmount that
 * tears down all React state, and the consume-once contract guarantees a
 * stale id can never leak into an unrelated boot.
 *
 * @module
 */

let pendingResumeSessionId: string | null = null;

/** Record the session id the picker wants to relaunch into. */
export function setPendingResumeSessionId(sessionId: string): void {
  pendingResumeSessionId = sessionId;
}

/**
 * Read and clear the pending resume id. Returns `null` when no resume was
 * requested. The consume-once semantics ensure a second boot does not
 * accidentally re-resume.
 */
export function consumePendingResumeSessionId(): string | null {
  const id = pendingResumeSessionId;
  pendingResumeSessionId = null;
  return id;
}

/** Test-only reset so the module-level slot does not leak across cases. */
export function resetPendingResumeSessionIdForTestingOnly(): void {
  pendingResumeSessionId = null;
}
