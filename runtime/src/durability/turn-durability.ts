/**
 * Turn-scoped durability.
 *
 * Between the steps of a turn, a record only has to survive the process
 * dying (a crash, an OOM kill, a daemon restart), and a completed write()
 * already does: its bytes are in the kernel. So while a turn runs, its
 * canonical journal and snapshot writes complete their write() in order,
 * before the next model request and before the step's tools run, and do not
 * wait on fsync (F_FULLFSYNC on macOS). Power-loss and kernel-panic
 * durability comes from a synchronous flush at each turn boundary (complete,
 * aborted, failed), from the records that stay write-ahead because another
 * store commits a reference to them (see `SessionStore`), and from a
 * background flush that runs at most {@link DEFERRED_SYNC_INTERVAL_MS} after
 * the oldest write it covers.
 *
 * SQLite keeps its own durability (`synchronous = FULL`): admission and usage
 * commit there before their journal projection, so recovery can always
 * re-project what the journal is missing.
 *
 * This module records which turns are open in the process; each canonical
 * journal tracks its own unsynced bytes (`SessionStore.deferSyncsForTurn`).
 *
 * @module
 */

/** The longest a written record waits for its background flush. */
export const DEFERRED_SYNC_INTERVAL_MS = 1_000;

/** How a turn ends its scope: a turn boundary flushes; a hand-off does not. */
export type TurnDurabilityRelease = (mode?: "sync" | "background") => void;

const openTurns = new Map<string, number>();

/** Open a turn's durability scope for `ownerId` (the conversation id). Scopes nest. */
export function openTurnDurabilityScope(ownerId: string): () => void {
  openTurns.set(ownerId, (openTurns.get(ownerId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (openTurns.get(ownerId) ?? 1) - 1;
    if (remaining > 0) openTurns.set(ownerId, remaining);
    else openTurns.delete(ownerId);
  };
}

/** Whether a turn of `ownerId` is running in this process. */
export function turnDurabilityOpen(ownerId: string): boolean {
  return openTurns.has(ownerId);
}

/** @internal Test seam: forget every open scope. */
export function resetTurnDurabilityForTest(): void {
  openTurns.clear();
}
