import {
  isLocalShellTask,
  type LocalShellTaskState,
  type TaskState,
} from "../../../tasks/types.js";

export function resolveWorkbenchShellTask(
  tasks: Readonly<Record<string, TaskState>> | null | undefined,
  selectedTaskId: string | null | undefined,
): LocalShellTaskState | null {
  const selectedTask = selectedTaskId ? tasks?.[selectedTaskId] : undefined;
  if (isLocalShellTask(selectedTask)) return selectedTask;
  return Object.values(tasks ?? {}).find(isLocalShellTask) ?? null;
}
