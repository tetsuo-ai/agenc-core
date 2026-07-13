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
  return normalizedStringsReferencePath(normalizedTaskSearchStrings(task), normalized);
}

export function inFlightPathsFromTasks(
  tasks: readonly TaskState[],
  candidatePaths: readonly string[],
): string[] {
  const activeTasks = tasks.filter((task) =>
    task.type !== "local_bash" && (task.status === "pending" || task.status === "running")
  );
  if (activeTasks.length === 0) return [];
  // Serialize each task's search strings ONCE (taskSearchStrings JSON.stringifies
  // lastActivity.input and every recentActivities[].input). Previously this ran
  // inside the per-candidate-path filter, re-serializing the same inputs
  // paths × tasks times — driven over the full expanded tree on every streamed
  // agent-progress event.
  const perTaskStrings = activeTasks.map((task) => normalizedTaskSearchStrings(task));
  return candidatePaths.filter((pathValue) => {
    const normalized = normalizePath(pathValue);
    if (normalized.length === 0) return false;
    return perTaskStrings.some((strings) => normalizedStringsReferencePath(strings, normalized));
  });
}

function normalizedTaskSearchStrings(task: TaskState): string[] {
  return taskSearchStrings(task).map((value) => normalizePath(value));
}

function normalizedStringsReferencePath(
  normalizedStrings: readonly string[],
  normalizedPath: string,
): boolean {
  return normalizedStrings.some((value) => containsPathReference(value, normalizedPath));
}

export function taskPathLabel(task: TaskState): string | null {
  const record = task as unknown as Record<string, unknown>;
  for (const key of ["cwd", "worktreePath", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function taskSearchStrings(task: TaskState): string[] {
  const progress = "progress" in task ? task.progress : undefined;
  const values: unknown[] = [
    task.id,
    task.description,
    taskPathLabel(task) ?? "",
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
  return values.filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0
  );
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
  return value.trim().replace(/\\\\/gu, "/").replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function containsPathReference(value: string, pathValue: string): boolean {
  let index = value.indexOf(pathValue);
  while (index !== -1) {
    const before = index > 0 ? value[index - 1] : "";
    const after = value[index + pathValue.length] ?? "";
    if (isPathReferenceStart(before) && isPathReferenceEnd(after)) return true;
    index = value.indexOf(pathValue, index + 1);
  }
  return false;
}

function isPathReferenceStart(value: string): boolean {
  return value === "" || value === "/" || !isPathContinuation(value);
}

function isPathReferenceEnd(value: string): boolean {
  return value === "" || !isPathContinuation(value);
}

function isPathContinuation(value: string): boolean {
  return /^[\p{L}\p{N}._~+%/-]$/u.test(value);
}
