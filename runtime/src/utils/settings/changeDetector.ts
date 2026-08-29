import chokidar, { type FSWatcher } from "chokidar";
import { stat } from "node:fs/promises";
import * as platformPath from "node:path";

import { getIsRemoteMode } from "../../bootstrap/state.js";
import { registerCleanup } from "../cleanupRegistry.js";
import { logForDebugging } from "../debug.js";
import {
  type ConfigChangeSource,
  executeConfigChangeHooks,
  hasBlockingResult,
} from "../hooks.js";
import { createSignal } from "../signal.js";
import { type SettingSource } from "./constants.js";
import { clearInternalWrites, consumeInternalWrite } from "./internalWrites.js";
import {
  getCanonicalConfigLayers,
  getCanonicalSettingsAuthority,
} from "./canonicalAuthority.js";
import { getSettingsFilePathForSource } from "./settings.js";

const FILE_STABILITY_THRESHOLD_MS = 1_000;
const FILE_STABILITY_POLL_INTERVAL_MS = 500;
const INTERNAL_WRITE_WINDOW_MS = 5_000;
const DELETION_GRACE_MS =
  FILE_STABILITY_THRESHOLD_MS + FILE_STABILITY_POLL_INTERVAL_MS + 200;

let watcher: FSWatcher | null = null;
let initialized = false;
let disposed = false;
const pendingDeletions = new Map<string, ReturnType<typeof setTimeout>>();
const settingsChanged = createSignal<[source: SettingSource]>();
let watchedSources = new Map<string, SettingSource>();

let testOverrides: {
  stabilityThreshold?: number;
  pollInterval?: number;
  mdmPollInterval?: number;
  deletionGrace?: number;
} | null = null;

function normalized(path: string): string {
  return platformPath.normalize(path);
}

function sourcePaths(): Map<string, SettingSource> {
  const paths = new Map<string, SettingSource>();
  const authority = getCanonicalSettingsAuthority();
  for (const source of [
    "userSettings",
    "projectSettings",
    "localSettings",
    "flagSettings",
    "policySettings",
  ] as const) {
    const path = getSettingsFilePathForSource(source);
    if (path) paths.set(normalized(path), source);
  }
  for (const layer of getCanonicalConfigLayers("managed")) {
    if (layer.path) paths.set(normalized(layer.path), "policySettings");
  }
  // Mutable runtime facts share the same request-scoped HomeContext as the
  // ConfigStore; never re-resolve process.env from a watcher.
  if (authority) {
    paths.set(normalized(authority.homeContext.statePath), "userSettings");
  }
  return paths;
}

async function existingParentDirectories(
  paths: ReadonlyMap<string, SettingSource>,
): Promise<string[]> {
  const directories = new Set<string>();
  for (const path of paths.keys()) {
    const parent = platformPath.dirname(path);
    try {
      const info = await stat(parent);
      if (info.isDirectory()) directories.add(parent);
    } catch {
      // The strict repository creates the directory on the first canonical write.
    }
  }
  return [...directories];
}

export async function initialize(): Promise<void> {
  if (getIsRemoteMode() || initialized || disposed) return;
  initialized = true;
  registerCleanup(dispose);

  watchedSources = sourcePaths();
  const directories = await existingParentDirectories(watchedSources);
  if (disposed || directories.length === 0) return;

  logForDebugging(
    `Watching canonical config/state files ${[...watchedSources.keys()].join(", ")}`,
  );
  watcher = chokidar.watch(directories, {
    persistent: true,
    ignoreInitial: true,
    depth: 1,
    awaitWriteFinish: {
      stabilityThreshold:
        testOverrides?.stabilityThreshold ?? FILE_STABILITY_THRESHOLD_MS,
      pollInterval:
        testOverrides?.pollInterval ?? FILE_STABILITY_POLL_INTERVAL_MS,
    },
    ignored: (path, stats) => {
      if (stats && !stats.isFile() && !stats.isDirectory()) return true;
      if (!stats || stats.isDirectory()) return false;
      return !watchedSources.has(normalized(path));
    },
    ignorePermissionErrors: true,
    usePolling: false,
    atomic: true,
  });
  watcher.on("change", handleChange);
  watcher.on("unlink", handleDelete);
  watcher.on("add", handleAdd);
}

export function dispose(): Promise<void> {
  disposed = true;
  for (const timer of pendingDeletions.values()) clearTimeout(timer);
  pendingDeletions.clear();
  clearInternalWrites();
  settingsChanged.clear();
  watchedSources = new Map();
  const current = watcher;
  watcher = null;
  return current ? current.close() : Promise.resolve();
}

export const subscribe = settingsChanged.subscribe;

function settingSourceToConfigChangeSource(
  source: SettingSource,
): ConfigChangeSource {
  switch (source) {
    case "userSettings": return "user_settings";
    case "projectSettings": return "project_settings";
    case "localSettings": return "local_settings";
    case "flagSettings":
    case "policySettings":
      return "policy_settings";
  }
}

function sourceFor(path: string): SettingSource | undefined {
  return watchedSources.get(normalized(path));
}

function handleChange(path: string): void {
  const source = sourceFor(path);
  if (!source) return;
  const pending = pendingDeletions.get(path);
  if (pending) {
    clearTimeout(pending);
    pendingDeletions.delete(path);
  }
  if (consumeInternalWrite(path, INTERNAL_WRITE_WINDOW_MS)) return;
  void executeConfigChangeHooks(
    settingSourceToConfigChangeSource(source),
    path,
  ).then((results) => {
    if (!hasBlockingResult(results)) fanOut(source);
  });
}

function handleAdd(path: string): void {
  handleChange(path);
}

function handleDelete(path: string): void {
  const source = sourceFor(path);
  if (!source || pendingDeletions.has(path)) return;
  const timer = setTimeout(
    (deletedPath: string, deletedSource: SettingSource) => {
      pendingDeletions.delete(deletedPath);
      void executeConfigChangeHooks(
        settingSourceToConfigChangeSource(deletedSource),
        deletedPath,
      ).then((results) => {
        if (!hasBlockingResult(results)) fanOut(deletedSource);
      });
    },
    testOverrides?.deletionGrace ?? DELETION_GRACE_MS,
    path,
    source,
  );
  pendingDeletions.set(path, timer);
}

function fanOut(source: SettingSource): void {
  settingsChanged.emit(source);
  const authority = getCanonicalSettingsAuthority();
  void authority?.reload?.();
}

export function notifyChange(source: SettingSource): void {
  fanOut(source);
}

export function resetForTesting(overrides?: {
  stabilityThreshold?: number;
  pollInterval?: number;
  mdmPollInterval?: number;
  deletionGrace?: number;
}): Promise<void> {
  for (const timer of pendingDeletions.values()) clearTimeout(timer);
  pendingDeletions.clear();
  watchedSources = new Map();
  initialized = false;
  disposed = false;
  testOverrides = overrides ?? null;
  const current = watcher;
  watcher = null;
  return current ? current.close() : Promise.resolve();
}

export const settingsChangeDetector = {
  initialize,
  dispose,
  subscribe,
  notifyChange,
  resetForTesting,
};
