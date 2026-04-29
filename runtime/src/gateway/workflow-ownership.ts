import { coerceSessionShellProfile } from "./shell-profile.js";
import type { SessionShellProfile } from "./session.js";
import type { WorkflowOwnershipEntry } from "./watch-cockpit.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function collectSessionWorkflowOwnership(params: {
  readonly runtimeStatusSnapshot?: Record<string, unknown>;
  readonly taskResult: Record<string, unknown>;
  readonly childInfos: readonly {
    sessionId: string;
    status: string;
    task: string;
    role?: string;
    roleSource?: string;
    toolBundle?: string;
    taskId?: string;
    shellProfile?: SessionShellProfile;
    workspaceRoot?: string;
    workingDirectory?: string;
    executionLocation?: string;
    worktreePath?: string;
  }[];
}): readonly WorkflowOwnershipEntry[] {
  const tasks = Array.isArray(params.taskResult.tasks)
    ? params.taskResult.tasks
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
  const taskSubjects = new Map<string, string>();
  for (const task of tasks) {
    if (typeof task.id === "string" && typeof task.subject === "string") {
      taskSubjects.set(task.id, task.subject);
    }
  }

  const workers = Array.isArray(params.runtimeStatusSnapshot?.openWorkers)
    ? params.runtimeStatusSnapshot!.openWorkers
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
  const childIndex = new Map(
    params.childInfos.map((entry) => [entry.sessionId, entry]),
  );
  const entries: WorkflowOwnershipEntry[] = [];
  const claimedChildSessions = new Set<string>();

  for (const worker of workers) {
    const childSessionId =
      typeof worker.continuationSessionId === "string"
        ? worker.continuationSessionId
        : undefined;
    if (childSessionId) {
      claimedChildSessions.add(childSessionId);
    }
    const executionLocation = asRecord(worker.executionLocation);
    const worktreePath =
      executionLocation?.mode === "worktree" &&
      typeof executionLocation.worktreePath === "string"
        ? executionLocation.worktreePath
        : undefined;
    const taskId =
      typeof worker.currentTaskId === "string"
        ? worker.currentTaskId
        : typeof worker.taskId === "string"
          ? worker.taskId
          : typeof worker.lastTaskId === "string"
            ? worker.lastTaskId
            : undefined;
    entries.push({
      role:
        typeof worker.state === "string" && worker.state === "verifying"
          ? "verifier-worker"
          : "worker",
      state: typeof worker.state === "string" ? worker.state : "unknown",
      ...(taskId ? { taskId } : {}),
      ...(taskId && taskSubjects.get(taskId)
        ? { taskSubject: taskSubjects.get(taskId) }
        : {}),
      ...(childSessionId ? { childSessionId } : {}),
      ...(typeof worker.workerId === "string" ? { workerId: worker.workerId } : {}),
      ...(typeof worker.shellProfile === "string" &&
      coerceSessionShellProfile(worker.shellProfile)
        ? { shellProfile: coerceSessionShellProfile(worker.shellProfile) }
        : childSessionId && childIndex.get(childSessionId)?.shellProfile
          ? { shellProfile: childIndex.get(childSessionId)!.shellProfile }
          : {}),
      ...(executionLocation && typeof executionLocation.mode === "string"
        ? { executionLocation: executionLocation.mode }
        : {}),
      ...(executionLocation && typeof executionLocation.workspaceRoot === "string"
        ? { workspaceRoot: executionLocation.workspaceRoot }
        : {}),
      ...(executionLocation && typeof executionLocation.workingDirectory === "string"
        ? { workingDirectory: executionLocation.workingDirectory }
        : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(executionLocation && typeof executionLocation.worktreeRef === "string"
        ? { branch: executionLocation.worktreeRef }
        : {}),
      ...(executionLocation && typeof executionLocation.head === "string"
        ? { head: executionLocation.head }
        : {}),
    });
  }

  for (const child of params.childInfos) {
    if (claimedChildSessions.has(child.sessionId)) continue;
    const normalizedTask = child.task.toLowerCase();
    const role =
      child.role ??
      (normalizedTask.includes("review")
        ? "reviewer"
        : normalizedTask.includes("verify")
          ? "verifier"
          : normalizedTask.includes("plan")
            ? "planner"
            : "child");
    entries.push({
      role,
      state: child.status,
      ...(child.roleSource ? { roleSource: child.roleSource } : {}),
      ...(child.toolBundle ? { toolBundle: child.toolBundle } : {}),
      ...(child.taskId ? { taskId: child.taskId } : {}),
      childSessionId: child.sessionId,
      shellProfile: child.shellProfile,
      taskSubject: child.task,
      ...(child.workspaceRoot ? { workspaceRoot: child.workspaceRoot } : {}),
      ...(child.workingDirectory ? { workingDirectory: child.workingDirectory } : {}),
      ...(child.executionLocation ? { executionLocation: child.executionLocation } : {}),
      ...(child.worktreePath ? { worktreePath: child.worktreePath } : {}),
    });
  }

  return entries;
}

export function formatWorkflowOwnershipReply(
  entries: readonly WorkflowOwnershipEntry[],
): string {
  if (entries.length === 0) {
    return "Workflow ownership: none";
  }
  return [
    `Workflow ownership (${entries.length}):`,
    ...entries.map((entry) =>
      [
        `  ${entry.role}`,
        `[${entry.state}]`,
        entry.roleSource ? `source=${entry.roleSource}` : null,
        entry.toolBundle ? `bundle=${entry.toolBundle}` : null,
        entry.taskId ? `task=${entry.taskId}` : null,
        entry.taskSubject ? `subject=${entry.taskSubject}` : null,
        entry.childSessionId ? `child=${entry.childSessionId}` : null,
        entry.workerId ? `worker=${entry.workerId}` : null,
        entry.shellProfile ? `profile=${entry.shellProfile}` : null,
        entry.executionLocation ? `exec=${entry.executionLocation}` : null,
        entry.workspaceRoot ? `workspace=${entry.workspaceRoot}` : null,
        entry.workingDirectory ? `cwd=${entry.workingDirectory}` : null,
        entry.worktreePath ? `worktree=${entry.worktreePath}` : null,
        entry.branch ? `branch=${entry.branch}` : null,
        entry.head ? `head=${entry.head}` : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" "),
    ),
  ].join("\n");
}
