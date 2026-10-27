/** Startup waiting has a deadline independent of the subsequent agent turn. */
export const STARTUP_RESTORE_WAIT_TIMEOUT_MS = 120_000;
export const STARTUP_RESTORE_PROGRESS_METHOD = "event.startup_restore";

export function startupRestoreProgressLine(remaining: number): string {
  return `Reopening ${remaining} ${remaining === 1 ? "session" : "sessions"}...\n`;
}

/** One request can enter and leave a restore wait only once. */
export function createStartupRestoreWait(options: {
  readonly write: (line: string) => void;
  readonly timedOut: () => void;
  readonly timeoutMs?: number;
}) {
  let started = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    update(remaining: number): "started" | "finished" | undefined {
      if (finished) return;
      if (remaining === 0) {
        close();
        return started ? "finished" : undefined;
      }
      if (started) return;
      started = true;
      options.write(startupRestoreProgressLine(remaining));
      timer = setTimeout(() => {
        close();
        options.timedOut();
      }, options.timeoutMs ?? STARTUP_RESTORE_WAIT_TIMEOUT_MS);
      return "started";
    },
    close,
  };
}
