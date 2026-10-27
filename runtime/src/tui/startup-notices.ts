/**
 * Notices the CLI entry hands to the TUI before it mounts. The TUI owns the
 * terminal once it starts, so a line written to stderr before then is never
 * seen; App shows each queued notice once in the footer.
 */
export interface TuiStartupNotice {
  readonly key: string;
  readonly text: string;
}

const pending: TuiStartupNotice[] = [];

export function queueTuiStartupNotice(notice: TuiStartupNotice): void {
  if (pending.some((entry) => entry.key === notice.key)) return;
  pending.push(notice);
}

/** Hand every queued notice over once; later calls get only newer ones. */
export function takeTuiStartupNotices(): readonly TuiStartupNotice[] {
  return pending.splice(0, pending.length);
}
