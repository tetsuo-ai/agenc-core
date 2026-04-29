import type { TaskExternalRef, TaskStore } from "../tools/system/task-tracker.js";

function buildTrackedSubagentExternalRef(params: {
  readonly childSessionId: string;
  readonly label?: string;
}): TaskExternalRef {
  return {
    kind: "subagent",
    id: params.childSessionId,
    sessionId: params.childSessionId,
    ...(params.label ? { label: params.label } : {}),
  };
}

export async function attachTrackedSubagentTask(params: {
  readonly taskStore: TaskStore;
  readonly listId: string;
  readonly taskId: string;
  readonly childSessionId: string;
  readonly label?: string;
  readonly summary?: string;
}): Promise<void> {
  await params.taskStore.attachExternalRef(
    params.listId,
    params.taskId,
    buildTrackedSubagentExternalRef({
      childSessionId: params.childSessionId,
      label: params.label,
    }),
    params.summary,
  );
}

export async function finalizeTrackedSubagentTask(
  params: Omit<Parameters<TaskStore["finalizeRuntimeTask"]>[0], "externalRef"> & {
    readonly taskStore: TaskStore;
    readonly childSessionId?: string;
    readonly label?: string;
  },
): Promise<void> {
  await params.taskStore.finalizeRuntimeTask({
    listId: params.listId,
    taskId: params.taskId,
    status: params.status,
    summary: params.summary,
    ...(params.output !== undefined ? { output: params.output } : {}),
    ...(params.structuredOutput !== undefined
      ? { structuredOutput: params.structuredOutput }
      : {}),
    ...(params.runtimeResult !== undefined
      ? { runtimeResult: params.runtimeResult }
      : {}),
    ...(params.usage !== undefined ? { usage: params.usage } : {}),
    ...(params.verifierVerdict !== undefined
      ? { verifierVerdict: params.verifierVerdict }
      : {}),
    ...(params.ownedArtifacts !== undefined
      ? { ownedArtifacts: params.ownedArtifacts }
      : {}),
    ...(params.workingDirectory !== undefined
      ? { workingDirectory: params.workingDirectory }
      : {}),
    ...(params.isolation !== undefined ? { isolation: params.isolation } : {}),
    ...(params.executionLocation !== undefined
      ? { executionLocation: params.executionLocation }
      : {}),
    ...(params.eventData !== undefined ? { eventData: params.eventData } : {}),
    ...(params.childSessionId
      ? {
          externalRef: buildTrackedSubagentExternalRef({
            childSessionId: params.childSessionId,
            label: params.label,
          }),
        }
      : {}),
  });
}
