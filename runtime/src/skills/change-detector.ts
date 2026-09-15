import type { WatchRegistration } from "../file-watcher/index.js";
import { FileWatcher } from "../file-watcher/index.js";
import { createSignal } from "../utils/signal.js";

/**
 * Ports the upstream skill change detection behavior onto AgenC's shared
 * FileWatcher so skill roots hot-reload without a separate watcher.
 */

const DEFAULT_RELOAD_DEBOUNCE_MS = 300;

export interface SkillChangeEvent {
  readonly changedPaths: readonly string[];
}

export interface SkillChangeDetectorOptions {
  readonly fileWatcher?: FileWatcher;
  readonly getWatchRoots: () => Promise<readonly string[]>;
  readonly onReload?: (event: SkillChangeEvent) => void | Promise<void>;
  readonly debounceMs?: number;
  readonly clearRuntimeCaches?: boolean;
  readonly runConfigChangeHooks?: boolean;
  readonly forwardTo?: Pick<SkillChangeDetector, "notify">;
  readonly executeConfigChangeHooks?: (
    source: "skills",
    changedPath: string,
  ) => Promise<readonly unknown[]>;
  readonly hasBlockingResult?: (results: readonly unknown[]) => boolean;
  /** Additional bound source; getWatchRoots always describes controller paths. */
  readonly subscribeChanges?: (changed: (paths: readonly string[]) => void,
    failed: (error: unknown) => void) => Promise<{ close(): void | Promise<void> }>;
  readonly onError?: (error: unknown) => void;
}

export interface SkillChangeDetector {
  initialize(options: SkillChangeDetectorOptions): Promise<void>;
  dispose(): Promise<void>;
  resetForTesting(): Promise<void>;
  subscribe(listener: (event: SkillChangeEvent) => void): () => void;
  notify(event: SkillChangeEvent): void;
  getFailure?(): unknown;
}

export function createSkillChangeDetector(): SkillChangeDetector {
  const skillsChanged = createSignal<[event: SkillChangeEvent]>();
  let fileWatcher: FileWatcher | null = null;
  let ownsFileWatcher = false;
  let registration: WatchRegistration | null = null;
  let subscriber: ReturnType<FileWatcher["addSubscriber"]>["subscriber"] | null = null;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let receiveLoopActive = false;
  let initialized = false;
  let disposed = false;
  let lifecycleVersion = 0;
  let activeOptions: SkillChangeDetectorOptions | null = null;
  const pendingChangedPaths = new Set<string>();
  let firstPendingChangedPath: string | null = null;
  let externalSubscription: { close(): void | Promise<void> } | null = null;
  let failure: unknown;
  let initializing: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;

  function reportFailure(error: unknown, version: number): void {
    if (disposed || version !== lifecycleVersion) return;
    failure = error;
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = null;
    pendingChangedPaths.clear();
    firstPendingChangedPath = null;
    try { activeOptions?.onError?.(error); }
    catch (reportError) { failure = new AggregateError([error, reportError], "Skill reload and error reporting failed", { cause: error }); }
  }

  function initialize(
    options: SkillChangeDetectorOptions,
  ): Promise<void> {
    if (stopping) return stopping.then(() => initialize(options));
    if (initializing) return initializing;
    if (initialized) return Promise.resolve();
    initialized = true;
    disposed = false;
    lifecycleVersion += 1;
    const version = lifecycleVersion;
    activeOptions = options;
    failure = undefined;

    initializing = (async () => {
      try {
        const roots = await options.getWatchRoots();
        if (disposed || version !== lifecycleVersion) return;
        if (options.subscribeChanges) {
          const subscribed = await options.subscribeChanges(
            (paths) => { if (version === lifecycleVersion && !disposed) scheduleReload(paths); },
            (error) => reportFailure(error, version),
          );
          if (disposed || version !== lifecycleVersion) { await subscribed.close(); return; }
          externalSubscription = subscribed;
        }
        if (roots.length > 0) {
          fileWatcher = options.fileWatcher ?? FileWatcher.create();
          ownsFileWatcher = options.fileWatcher === undefined;
          const added = fileWatcher.addSubscriber();
          subscriber = added.subscriber;
          registration = added.subscriber.registerPaths(
            roots.map((root) => ({ path: root, recursive: true })),
          );
          receiveLoopActive = true;
          void receiveChanges(added.receiver, version).catch((error) => reportFailure(error, version));
        }
      } catch (error) {
        if (version === lifecycleVersion) {
          // A rejected provider may retain callbacks. Revoke them immediately,
          // including the interval before any subsequent initialize() call.
          disposed = true;
          lifecycleVersion += 1;
          initialized = false;
          activeOptions = null;
          try { await releaseWatchers(); }
          catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Skill watch setup and cleanup failed", { cause: error });
          }
        }
        throw error;
      }
    })().finally(() => { initializing = null; });
    return initializing;
  }

  function subscribe(listener: (event: SkillChangeEvent) => void): () => void {
    return skillsChanged.subscribe(listener);
  }

  function notify(event: SkillChangeEvent): void {
    skillsChanged.emit(event);
  }

  function dispose(): Promise<void> {
    if (stopping) return stopping;
    disposed = true;
    initialized = false;
    lifecycleVersion += 1;
    activeOptions = null;
    skillsChanged.clear();
    const setup = initializing;
    const release = releaseWatchers();
    stopping = (async () => {
      // A pending subscription closes itself after observing the lifecycle fence.
      // Wait for that closure before advertising that disposal is complete.
      const results = await Promise.allSettled([release, setup]);
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Skill watch cleanup failed");
    })().finally(() => { stopping = null; });
    return stopping;
  }

  async function releaseWatchers(): Promise<void> {
    if (reloadTimer !== null) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
    pendingChangedPaths.clear();
    firstPendingChangedPath = null;
    registration?.close();
    registration = null;
    subscriber?.close();
    subscriber = null;
    if (ownsFileWatcher) fileWatcher?.close();
    fileWatcher = null;
    ownsFileWatcher = false;
    receiveLoopActive = false;
    const external = externalSubscription;
    externalSubscription = null;
    await external?.close();
  }

  async function resetForTesting(): Promise<void> {
    await dispose();
    disposed = false;
    initialized = false;
    activeOptions = null;
  }

  async function receiveChanges(
    receiver: ReturnType<FileWatcher["addSubscriber"]>["receiver"],
    version: number,
  ): Promise<void> {
    while (receiveLoopActive && version === lifecycleVersion) {
      const event = await receiver.recv();
      if (event === null || disposed || version !== lifecycleVersion) return;
      scheduleReload(event.paths);
    }
  }

  function scheduleReload(changedPaths: readonly string[]): void {
    if (disposed || failure !== undefined || changedPaths.length === 0) return;
    for (const changedPath of changedPaths) {
      if (shouldIgnorePath(changedPath)) continue;
      if (firstPendingChangedPath === null) firstPendingChangedPath = changedPath;
      pendingChangedPaths.add(changedPath);
    }
    if (pendingChangedPaths.size === 0) return;

    if (reloadTimer !== null) clearTimeout(reloadTimer);
    const version = lifecycleVersion;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      void flushReload(version).catch((error) => reportFailure(error, version));
    }, activeOptions?.debounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS);
  }

  async function flushReload(version: number): Promise<void> {
    if (disposed || failure !== undefined || version !== lifecycleVersion || pendingChangedPaths.size === 0) return;
    const options = activeOptions;
    const hookRepresentativePath =
      firstPendingChangedPath ?? pendingChangedPaths.values().next().value ?? "";
    const changedPaths = [...pendingChangedPaths].sort();
    pendingChangedPaths.clear();
    firstPendingChangedPath = null;

    if (await configChangeHookBlocked(hookRepresentativePath)) return;
    if (disposed || failure !== undefined || version !== lifecycleVersion) return;

    const event = { changedPaths };
    await options?.onReload?.(event);
    if (disposed || failure !== undefined || version !== lifecycleVersion) return;
    if (options?.clearRuntimeCaches !== false) {
      await resetSkillAnnouncementState();
      await clearCommandCaches();
    }
    if (disposed || failure !== undefined || version !== lifecycleVersion) return;
    notify(event);
    options?.forwardTo?.notify(event);
  }

  async function configChangeHookBlocked(changedPath: string): Promise<boolean> {
    const options = activeOptions;
    if (options?.runConfigChangeHooks === false) return false;

    if (
      options?.executeConfigChangeHooks !== undefined &&
      options.hasBlockingResult !== undefined
    ) {
      const results = await options.executeConfigChangeHooks(
        "skills",
        changedPath,
      );
      return options.hasBlockingResult(results);
    }

    try {
      const hooks = await import("../utils/hooks.js");
      const results = await hooks.executeConfigChangeHooks("skills", changedPath);
      return hooks.hasBlockingResult(results);
    } catch {
      return false;
    }
  }

  return {
    initialize,
    dispose,
    resetForTesting,
    subscribe,
    notify,
    getFailure: () => failure,
  };
}

async function resetSkillAnnouncementState(): Promise<void> {
  try {
    const attachments = await import("../utils/attachments.js");
    attachments.resetSentSkillNames?.();
  } catch {
    // Hot reload is best-effort; cache clearing should never break a session.
  }
}

async function clearCommandCaches(): Promise<void> {
  try {
    const commands = await import("../commands.js");
    commands.clearCommandsCache?.();
  } catch {
    // Hot reload is best-effort; cache clearing should never break a session.
  }
}

function shouldIgnorePath(path: string): boolean {
  return path.split(/[\\/]/u).includes(".git");
}

export const skillChangeDetector = createSkillChangeDetector();
