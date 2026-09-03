import { watch, type FSWatcher, type WatchEventType } from "node:fs";
import { basename, dirname } from "node:path";

const ACTIVE_POLL_INTERVAL_MS = 250;
const IDLE_POLL_INTERVAL_MS = 1_000;

type WatchFactory = (
  directoryPath: string,
  options: { readonly persistent: false },
  listener: (
    eventType: WatchEventType,
    filename: string | Buffer | null,
  ) => void,
) => FSWatcher;

type ScheduleTimeout = (
  callback: () => void,
  delay: number,
) => ReturnType<typeof setTimeout>;

export type CompletionPipelineWatcherOptions = {
  readonly eventLogPath: string;
  readonly refresh: () => boolean;
  readonly watchDirectory?: WatchFactory;
  readonly scheduleTimeout?: ScheduleTimeout;
  readonly cancelTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly activePollIntervalMs?: number;
  readonly idlePollIntervalMs?: number;
};

export function watchCompletionPipelineEventLog(
  options: CompletionPipelineWatcherOptions,
): () => void {
  const watchDirectory = options.watchDirectory ?? watch;
  const scheduleTimeout = options.scheduleTimeout ?? setTimeout;
  const cancelTimeout = options.cancelTimeout ?? clearTimeout;
  const activePollIntervalMs =
    options.activePollIntervalMs ?? ACTIVE_POLL_INTERVAL_MS;
  const idlePollIntervalMs =
    options.idlePollIntervalMs ?? IDLE_POLL_INTERVAL_MS;
  const directoryPath = dirname(options.eventLogPath);
  const eventLogName = basename(options.eventLogPath);
  let disposed = false;
  let watcher: FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const closeWatcher = (): void => {
    const current = watcher;
    watcher = null;
    current?.close();
  };

  const attachWatcher = (): void => {
    if (disposed || watcher !== null) return;
    try {
      const nextWatcher = watchDirectory(
        directoryPath,
        { persistent: false },
        (eventType, filename) => {
          if (disposed || watcher !== nextWatcher) return;
          if (filename !== null && filename.toString() !== eventLogName) return;
          const active = options.refresh();
          if (eventType === "rename") {
            closeWatcher();
            attachWatcher();
          }
          schedulePoll(active);
        },
      );
      watcher = nextWatcher;
      nextWatcher.on("error", () => {
        if (disposed || watcher !== nextWatcher) return;
        closeWatcher();
        attachWatcher();
      });
    } catch {
      watcher = null;
    }
  };

  const schedulePoll = (active: boolean): void => {
    if (disposed) return;
    if (pollTimer !== null) cancelTimeout(pollTimer);
    pollTimer = scheduleTimeout(
      () => {
        pollTimer = null;
        if (disposed) return;
        const nextActive = options.refresh();
        attachWatcher();
        schedulePoll(nextActive);
      },
      active ? activePollIntervalMs : idlePollIntervalMs,
    );
    (
      pollTimer as ReturnType<typeof setTimeout> & {
        unref?: () => void;
      }
    ).unref?.();
  };

  const active = options.refresh();
  attachWatcher();
  schedulePoll(active);

  return () => {
    if (disposed) return;
    disposed = true;
    closeWatcher();
    if (pollTimer !== null) {
      cancelTimeout(pollTimer);
      pollTimer = null;
    }
  };
}
