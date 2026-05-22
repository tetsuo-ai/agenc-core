import type { TaskState } from "../../../tasks/types.js";

export function formatTaskElapsed(
  task: Pick<TaskState, "startTime" | "endTime" | "totalPausedMs">,
  now = Date.now(),
): string {
  const end = task.endTime ?? now;
  const elapsedMs = Math.max(0, end - task.startTime - (task.totalPausedMs ?? 0));
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return `${hours}h${String(remainder).padStart(2, "0")}m`;
  }
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function taskMayReferencePath(task: TaskState, pathValue: string | null | undefined): boolean {
  if (!pathValue) return false;
  const normalized = normalizePath(pathValue);
  if (normalized.length === 0) return false;
  return taskSearchStrings(task).some((value) => normalizePath(value).includes(normalized));
}

export function inFlightPathsFromTasks(
  tasks: readonly TaskState[],
  candidatePaths: readonly string[],
): string[] {
  const activeTasks = tasks.filter((task) =>
    task.type !== "local_bash" && (task.status === "pending" || task.status === "running")
  );
  if (activeTasks.length === 0) return [];
  return candidatePaths.filter((pathValue) =>
    activeTasks.some((task) => taskMayReferencePath(task, pathValue))
  );
}

export function taskPathLabel(task: TaskState): string | null {
  const record = task as unknown as Record<string, unknown>;
  for (const key of ["cwd", "worktreePath", "path", "outputFile"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  const metadata = record.remoteTaskMetadata;
  if (metadata && typeof metadata === "object") {
    for (const key of ["cwd", "worktreePath", "path"]) {
      const value = (metadata as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return null;
}

function taskSearchStrings(task: TaskState): string[] {
  const progress = "progress" in task ? task.progress : undefined;
  const values: string[] = [
    task.id,
    task.description,
    "command" in task && typeof task.command === "string" ? task.command : "",
    "prompt" in task && typeof task.prompt === "string" ? task.prompt : "",
    "title" in task && typeof task.title === "string" ? task.title : "",
    progress?.lastActivity?.toolName ?? "",
    progress?.lastActivity?.activityDescription ?? "",
    stringifyInput(progress?.lastActivity?.input),
    ...(progress?.recentActivities ?? []).flatMap((activity) => [
      activity.toolName ?? "",
      activity.activityDescription ?? "",
      stringifyInput(activity.input),
    ]),
  ];
  return values.filter((value) => value.trim().length > 0);
}

function stringifyInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === undefined || input === null) return "";
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}
