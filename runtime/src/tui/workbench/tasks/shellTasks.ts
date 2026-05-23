import {
  isLocalShellTask,
  isStoppableTaskStatus,
  type LocalShellTaskState,
  type TaskState,
} from "../../../tasks/types.js";

export function resolveWorkbenchShellTask(
  tasks: Readonly<Record<string, TaskState>> | null | undefined,
  selectedTaskId: string | null | undefined,
): LocalShellTaskState | null {
  const selectedTask = selectedTaskId ? tasks?.[selectedTaskId] : undefined;
  if (isLocalShellTask(selectedTask)) return selectedTask;
  return Object.values(tasks ?? {})
    .filter(isLocalShellTask)
    .sort(compareShellTaskFallbacks)[0] ?? null;
}

function compareShellTaskFallbacks(
  left: LocalShellTaskState,
  right: LocalShellTaskState,
): number {
  const leftActive = isStoppableTaskStatus(left.status);
  const rightActive = isStoppableTaskStatus(right.status);
  if (leftActive !== rightActive) return leftActive ? -1 : 1;
  return (right.startTime ?? 0) - (left.startTime ?? 0);
}
