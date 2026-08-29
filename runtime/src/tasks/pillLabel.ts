/**
 * Ports donor `src/tasks/pillLabel.ts` compact background-task labels for
 * AgenC's shipped task kinds.
 *
 * Only task kinds owned by the live background-task lifecycle are accepted.
 */

import type { BackgroundTaskState } from "./types.js";

export function getPillLabel(
  tasks: readonly BackgroundTaskState[],
): string {
  const n = tasks.length;
  if (n === 0) {
    return "0 background tasks";
  }
  const first = tasks[0]!;
  const allSameType = tasks.every((task) => task.type === first.type);

  if (allSameType) {
    switch (first.type) {
      case "local_bash":
        return n === 1 ? "1 shell" : `${n} shells`;
      case "in_process_teammate": {
        const teamCount = new Set(
          tasks.map((task) =>
            task.type === "in_process_teammate" ? task.identity.teamName : "",
          ),
        ).size;
        return teamCount === 1 ? "1 team" : `${teamCount} teams`;
      }
      case "local_agent":
        return n === 1 ? "1 local agent" : `${n} local agents`;
    }
  }

  return `${n} background ${n === 1 ? "task" : "tasks"}`;
}
