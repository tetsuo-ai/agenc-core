/**
 * Subscribes to the task-store change signal and exposes the current
 * task list. Mirrors the live-load pattern of openclaude
 * `hooks/useTasksV2.ts` but with the team/teammate carve-outs stripped
 * and AgenC's per-project store as the source.
 *
 * @module
 */

import { useEffect, useState } from "react";
import {
  listWithUnresolved,
  onTasksUpdated,
  type ListedTask,
  type TaskStoreOptions,
} from "../../bin/task-store.js";

export interface UseTasksListOptions {
  readonly opts: TaskStoreOptions;
  /**
   * If true, deleted tasks are still returned. Default false matches the
   * sticky-panel use case where tombstones are hidden.
   */
  readonly includeDeleted?: boolean;
}

export function useTasksList(
  options: UseTasksListOptions,
): readonly ListedTask[] {
  const { opts, includeDeleted = false } = options;
  const [tasks, setTasks] = useState<readonly ListedTask[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      void listWithUnresolved(opts, includeDeleted ? { includeDeleted: true } : {})
        .then((next) => {
          if (cancelled) return;
          setTasks(next);
        })
        .catch(() => {
          if (cancelled) return;
          setTasks([]);
        });
    };
    refresh();
    const unsubscribe = onTasksUpdated(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [opts, includeDeleted]);

  return tasks;
}
