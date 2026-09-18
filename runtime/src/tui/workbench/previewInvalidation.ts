import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { useEffect, useSyncExternalStore } from "react";

import type { TaskState } from "../../tasks/types.js";
import { taskMayReferencePath } from "./agents/activity.js";
import { getProjectTreeStore } from "./project-tree/ProjectTreeStore.js";

type PreviewFileRevisionListener = () => void;

const previewFileRevisionListeners = new Set<PreviewFileRevisionListener>();
const previewFileChangeGenerations = new Map<string, number>();
const lastPreviewDiskRevisions = new Map<string, string>();

/**
 * Stable key for tasks that may have touched `path`. Status and endTime are
 * included so a start or completion changes the key; progress chatter does not.
 */
export function previewTaskEpoch(
  tasks: Readonly<Record<string, TaskState>>,
  path: string | null,
): string {
  if (!path) return "";
  return Object.values(tasks)
    .filter((task) => taskMayReferencePath(task, path))
    .map((task) => `${task.id}:${task.status}:${task.endTime ?? ""}`)
    .sort((left, right) => left.localeCompare(right))
    .join("\n");
}

export function previewFileRevisionKey(
  revision: {
    readonly mtimeMs: number;
    readonly size: number;
    readonly ino: number;
  } | null,
): string {
  if (revision === null) return "missing";
  return `${revision.mtimeMs}:${revision.size}:${revision.ino}`;
}

export async function readPreviewFileRevision(
  absolutePath: string,
): Promise<string> {
  try {
    const info = await stat(absolutePath);
    return previewFileRevisionKey({
      mtimeMs: info.mtimeMs,
      size: info.size,
      ino: info.ino,
    });
  } catch {
    return previewFileRevisionKey(null);
  }
}

export function subscribePreviewFileRevisions(
  listener: PreviewFileRevisionListener,
): () => void {
  previewFileRevisionListeners.add(listener);
  return () => {
    previewFileRevisionListeners.delete(listener);
  };
}

export function getPreviewFileChangeGeneration(
  absolutePath: string | null,
): number {
  if (!absolutePath) return 0;
  return previewFileChangeGenerations.get(absolutePath) ?? 0;
}

export function notifyPreviewFileChanged(absolutePath: string): void {
  previewFileChangeGenerations.set(
    absolutePath,
    (previewFileChangeGenerations.get(absolutePath) ?? 0) + 1,
  );
  for (const listener of previewFileRevisionListeners) listener();
}

export function resetPreviewFileRevisionsForTesting(): void {
  previewFileChangeGenerations.clear();
  previewFileRevisionListeners.clear();
  lastPreviewDiskRevisions.clear();
}

export function watchPreviewFile(
  absolutePath: string,
  onChange: () => void,
): () => void {
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(absolutePath, onChange);
  } catch {
    watcher = undefined;
  }
  return () => {
    watcher?.close();
  };
}

/**
 * Stable file-change generation for the selected preview path.
 * The first disk stat is recorded without notifying so mount does not
 * double-read. Later mtime/size/inode changes, fs.watch events, and
 * project-tree snapshot updates notify once.
 */
export function usePreviewFileRevision(absolutePath: string | null): number {
  const store = getProjectTreeStore();
  const treeSnapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const changeGeneration = useSyncExternalStore(
    subscribePreviewFileRevisions,
    () => getPreviewFileChangeGeneration(absolutePath),
    () => getPreviewFileChangeGeneration(absolutePath),
  );

  useEffect(() => {
    if (!absolutePath) return;
    let cancelled = false;
    void readPreviewFileRevision(absolutePath).then((revision) => {
      if (cancelled) return;
      const previous = lastPreviewDiskRevisions.get(absolutePath);
      lastPreviewDiskRevisions.set(absolutePath, revision);
      if (previous !== undefined && previous !== revision) {
        notifyPreviewFileChanged(absolutePath);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [absolutePath, treeSnapshot]);

  useEffect(() => {
    if (!absolutePath) return;
    return watchPreviewFile(absolutePath, () => {
      notifyPreviewFileChanged(absolutePath);
    });
  }, [absolutePath]);

  return changeGeneration;
}
