import type { WatchRegistration } from "../file-watcher/index.js";
import { FileWatcher } from "../file-watcher/index.js";
import { createSignal } from "../utils/signal.js";

/**
 * Ports the upstream skill change detection behavior onto AgenC's shared
 * FileWatcher so skills and command roots hot-reload without a separate
 * watcher implementation.
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
}

export interface SkillChangeDetector {
  initialize(options: SkillChangeDetectorOptions): Promise<void>;
  dispose(): Promise<void>;
  resetForTesting(): Promise<void>;
  subscribe(listener: (event: SkillChangeEvent) => void): () => void;
  notify(event: SkillChangeEvent): void;
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

  async function initialize(
    options: SkillChangeDetectorOptions,
  ): Promise<void> {
    if (initialized) return;
    initialized = true;
    disposed = false;
    lifecycleVersion += 1;
    const version = lifecycleVersion;
    activeOptions = options;

    let roots: readonly string[];
    try {
      roots = await options.getWatchRoots();
    } catch (error) {
      if (version === lifecycleVersion) {
        initialized = false;
        activeOptions = null;
      }
      throw error;
    }
    if (disposed || version !== lifecycleVersion) return;
    if (roots.length === 0) return;

    fileWatcher = options.fileWatcher ?? FileWatcher.create();
    ownsFileWatcher = options.fileWatcher === undefined;
    const added = fileWatcher.addSubscriber();
    subscriber = added.subscriber;
    registration = added.subscriber.registerPaths(
      roots.map((root) => ({ path: root, recursive: true })),
    );

    receiveLoopActive = true;
    void receiveChanges(added.receiver);
  }

  function subscribe(listener: (event: SkillChangeEvent) => void): () => void {
    return skillsChanged.subscribe(listener);
  }

  function notify(event: SkillChangeEvent): void {
    skillsChanged.emit(event);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    initialized = false;
    lifecycleVersion += 1;
    activeOptions = null;
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
    skillsChanged.clear();
  }

  async function resetForTesting(): Promise<void> {
    await dispose();
    disposed = false;
    initialized = false;
    activeOptions = null;
  }

  async function receiveChanges(
    receiver: ReturnType<FileWatcher["addSubscriber"]>["receiver"],
  ): Promise<void> {
    while (receiveLoopActive) {
      const event = await receiver.recv();
      if (event === null) return;
      scheduleReload(event.paths);
    }
  }

  function scheduleReload(changedPaths: readonly string[]): void {
    if (disposed || changedPaths.length === 0) return;
    for (const changedPath of changedPaths) {
      if (shouldIgnorePath(changedPath)) continue;
      if (firstPendingChangedPath === null) firstPendingChangedPath = changedPath;
      pendingChangedPaths.add(changedPath);
    }
    if (pendingChangedPaths.size === 0) return;

    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      void flushReload();
    }, activeOptions?.debounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS);
  }

  async function flushReload(): Promise<void> {
    if (disposed || pendingChangedPaths.size === 0) return;
    const hookRepresentativePath =
      firstPendingChangedPath ?? pendingChangedPaths.values().next().value ?? "";
    const changedPaths = [...pendingChangedPaths].sort();
    pendingChangedPaths.clear();
    firstPendingChangedPath = null;

    if (await configChangeHookBlocked(hookRepresentativePath)) return;
    if (disposed) return;

    const event = { changedPaths };
    await activeOptions?.onReload?.(event);
    if (disposed) return;
    const options = activeOptions;
    if (options?.clearRuntimeCaches !== false) {
      await resetSkillAnnouncementState();
      await clearCommandCaches();
    }
    if (disposed) return;
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
export const initialize = skillChangeDetector.initialize;
export const dispose = skillChangeDetector.dispose;
export const resetForTesting = skillChangeDetector.resetForTesting;
export const subscribe = skillChangeDetector.subscribe;
