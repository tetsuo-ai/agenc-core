/**
 * Subscribes to the task-store change signal, watches the backing task
 * directory, and exposes the current task list. Mirrors the live-load pattern
 * of openclaude `hooks/useTasksV2.ts` but with AgenC's per-project store as
 * the source.
 *
 * @module
 */

import { type FSWatcher, watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { useEffect, useState } from "react";
import {
  listWithUnresolved,
  onTasksUpdated,
  tasksDir,
  type ListedTask,
  type TaskStoreOptions,
} from "../../bin/task-store.js";

const HIDE_DELAY_MS = 5000;
const DEBOUNCE_MS = 50;
const FALLBACK_POLL_MS = 5000;

export interface UseTasksListOptions {
  readonly opts: TaskStoreOptions;
  /**
   * Reserved for compatibility with older callers. The live AgenC task store
   * deletes task files instead of returning tombstones, so this is currently
   * a no-op.
   */
  readonly includeDeleted?: boolean;
}

export function useTasksList(
  options: UseTasksListOptions,
): readonly ListedTask[] | undefined {
  const { opts, includeDeleted = false } = options;
  void includeDeleted;
  const [tasks, setTasks] = useState<readonly ListedTask[] | undefined>([]);

  useEffect(() => {
    let cancelled = false;
    let watcher: FSWatcher | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const clearHideTimer = (): void => {
      if (hideTimer === null) return;
      clearTimeout(hideTimer);
      hideTimer = null;
    };

    const clearPollTimer = (): void => {
      if (pollTimer === null) return;
      clearTimeout(pollTimer);
      pollTimer = null;
    };

    const schedulePoll = (): void => {
      clearPollTimer();
      pollTimer = setTimeout(scheduleRefresh, FALLBACK_POLL_MS);
      pollTimer.unref?.();
    };

    const hideIfStillComplete = (): void => {
      hideTimer = null;
      void listWithUnresolved(opts)
        .then((next) => {
          if (cancelled) return;
          const allStillComplete =
            next.length > 0 && next.every((task) => task.status === "completed");
          if (allStillComplete) {
            setTasks(undefined);
          } else {
            setTasks(next.length === 0 ? undefined : next);
          }
        })
        .catch(() => {
          if (cancelled) return;
          setTasks(undefined);
        });
    };

    const refresh = (): void => {
      void listWithUnresolved(opts)
        .then((next) => {
          if (cancelled) return;
          const hasIncomplete = next.some((task) => task.status !== "completed");
          clearPollTimer();
          if (next.length === 0) {
            clearHideTimer();
            setTasks(undefined);
            return;
          }
          setTasks(next);
          if (hasIncomplete) {
            clearHideTimer();
            schedulePoll();
            return;
          }
          if (hideTimer === null) {
            hideTimer = setTimeout(hideIfStillComplete, HIDE_DELAY_MS);
            hideTimer.unref?.();
          }
        })
        .catch(() => {
          if (cancelled) return;
          clearHideTimer();
          clearPollTimer();
          setTasks(undefined);
        });
    };

    function scheduleRefresh(): void {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refresh, DEBOUNCE_MS);
      debounceTimer.unref?.();
    }

    refresh();
    const unsubscribe = onTasksUpdated(scheduleRefresh);
    const dir = tasksDir(opts);
    void mkdir(dir, { recursive: true })
      .then(() => {
        if (cancelled) return;
        watcher = watch(dir, scheduleRefresh);
        watcher.unref?.();
      })
      .catch(() => {
        // Same-process updates and the fallback poll still keep the panel live.
      });

    return () => {
      cancelled = true;
      unsubscribe();
      watcher?.close();
      clearHideTimer();
      clearPollTimer();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    };
  }, [opts, includeDeleted]);

  return tasks;
}
