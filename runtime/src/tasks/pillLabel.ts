/**
 * Ports donor `src/tasks/pillLabel.ts` compact background-task labels for
 * AgenC's shipped task kinds.
 *
 * Shape differences from the donor:
 *   - Workflow, MCP monitor, and dream labels are absent because those task
 *     kinds are not shipped by the live runtime.
 *
 * Cross-cuts deliberately NOT carried:
 *   - No donor-only task kind is accepted by the typed discriminator.
 */

import type { BackgroundTaskState } from "./types.js";

function count<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  return items.reduce((total, item) => total + (predicate(item) ? 1 : 0), 0);
}

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
      case "local_bash": {
        const monitors = count(
          tasks,
          (task) => task.type === "local_bash" && task.kind === "monitor",
        );
        const shells = n - monitors;
        const parts: string[] = [];
        if (shells > 0) {
          parts.push(shells === 1 ? "1 shell" : `${shells} shells`);
        }
        if (monitors > 0) {
          parts.push(monitors === 1 ? "1 monitor" : `${monitors} monitors`);
        }
        return parts.join(", ");
      }
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
