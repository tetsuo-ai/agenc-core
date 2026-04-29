import type { WorkflowRequestMilestone } from "../workflow/request-completion.js";
import {
  normalizeWorkflowRequestMilestones,
} from "../workflow/request-completion.js";
import type {
  NormalizedRequestTaskRuntimeMetadata,
} from "../workflow/request-task-runtime.js";
import {
  normalizeRequestTaskRuntimeMetadata,
} from "../workflow/request-task-runtime.js";

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

interface ToolCallLike {
  readonly name: string;
  readonly result: string;
}

interface ParsedTaskRecord {
  readonly id: string;
  readonly status: TaskStatus;
  readonly updatedAt?: number;
  readonly fullTask: Record<string, unknown>;
  readonly runtimeMetadata: NormalizedRequestTaskRuntimeMetadata;
}

interface RequestTaskRecordState {
  readonly task: ParsedTaskRecord;
  readonly completedOrdinal?: number;
}

export interface RequestTaskMalformedTask {
  readonly taskId: string;
  readonly errors: readonly string[];
}

export interface RequestTaskProgressState {
  allowedMilestones: readonly WorkflowRequestMilestone[];
  tasksById: Map<string, RequestTaskRecordState>;
  nonDeletedTaskCount: number;
  inProgressTaskIds: readonly string[];
  verificationTaskIds: readonly string[];
  malformedTasks: readonly RequestTaskMalformedTask[];
  completedMilestoneIds: readonly string[];
  completedNonVerificationTaskIdsSinceVerification: readonly string[];
  nextCompletionOrdinal: number;
  verificationAnchorOrdinal: number;
}

export interface RequestTaskObservationResult {
  readonly source: "task.create" | "task.update" | "task.get";
  readonly nonDeletedTaskCount: number;
  readonly inProgressTaskCount: number;
}

export const REQUEST_TASK_PROGRESS_NO_TASK_YET_KEY =
  "request_task_progress:no-task-yet";
export const REQUEST_TASK_PROGRESS_NO_IN_PROGRESS_KEY =
  "request_task_progress:no-in-progress";

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(
  value: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function asTaskStatus(value: unknown): TaskStatus | undefined {
  switch (value) {
    case "pending":
    case "in_progress":
    case "completed":
    case "deleted":
      return value;
    default:
      return undefined;
  }
}

function parseTaskRuntimeRecord(
  record: ToolCallLike,
): ParsedTaskRecord | undefined {
  if (
    record.name !== "task.create" &&
    record.name !== "task.update" &&
    record.name !== "task.get"
  ) {
    return undefined;
  }

  const body = parseJsonObject(record.result);
  if (!body) return undefined;

  const taskRuntime = isPlainObject(body.taskRuntime) ? body.taskRuntime : undefined;
  const fullTask =
    (taskRuntime && isPlainObject(taskRuntime.fullTask)
      ? taskRuntime.fullTask
      : record.name === "task.get" && isPlainObject(body.task)
        ? body.task
        : undefined);
  if (!fullTask) return undefined;

  const taskId =
    typeof fullTask.id === "string" && fullTask.id.trim().length > 0
      ? fullTask.id.trim()
      : undefined;
  const status = asTaskStatus(fullTask.status);
  if (!taskId || !status) return undefined;

  const runtimeMetadata = normalizeRequestTaskRuntimeMetadata(
    isPlainObject(fullTask.metadata) ? fullTask.metadata : undefined,
  );
  return {
    id: taskId,
    status,
    updatedAt:
      typeof fullTask.updatedAt === "number" ? fullTask.updatedAt : undefined,
    fullTask,
    runtimeMetadata,
  };
}

function deriveState(state: RequestTaskProgressState): void {
  const allowedMilestoneIds = new Set(
    state.allowedMilestones.map((milestone) => milestone.id.trim()),
  );
  const completedMilestoneIds: string[] = [];
  const completedMilestoneSet = new Set<string>();
  const inProgressTaskIds: string[] = [];
  const verificationTaskIds: string[] = [];
  const malformedTasks: RequestTaskMalformedTask[] = [];
  const completedNonVerificationTaskIdsSinceVerification: string[] = [];
  let nonDeletedTaskCount = 0;

  for (const [taskId, entry] of state.tasksById.entries()) {
    if (entry.task.status === "deleted") {
      continue;
    }
    nonDeletedTaskCount += 1;

    if (entry.task.status === "in_progress") {
      inProgressTaskIds.push(taskId);
    }
    if (entry.task.runtimeMetadata.verification) {
      verificationTaskIds.push(taskId);
    }

    const errors = [...entry.task.runtimeMetadata.errors];
    if (allowedMilestoneIds.size > 0) {
      const unknownIds = entry.task.runtimeMetadata.milestoneIds.filter(
        (milestoneId) => !allowedMilestoneIds.has(milestoneId),
      );
      if (unknownIds.length > 0) {
        errors.push(
          `unknown request milestone ids: ${unknownIds.join(", ")}`,
        );
      }
    }

    if (errors.length > 0) {
      malformedTasks.push({ taskId, errors });
      continue;
    }

    if (entry.task.status === "completed") {
      for (const milestoneId of entry.task.runtimeMetadata.milestoneIds) {
        if (allowedMilestoneIds.size > 0 && !allowedMilestoneIds.has(milestoneId)) {
          continue;
        }
        if (completedMilestoneSet.has(milestoneId)) {
          continue;
        }
        completedMilestoneSet.add(milestoneId);
        completedMilestoneIds.push(milestoneId);
      }
      if (
        !entry.task.runtimeMetadata.verification &&
        entry.completedOrdinal !== undefined &&
        entry.completedOrdinal > state.verificationAnchorOrdinal
      ) {
        completedNonVerificationTaskIdsSinceVerification.push(taskId);
      }
    }
  }

  state.nonDeletedTaskCount = nonDeletedTaskCount;
  state.inProgressTaskIds = inProgressTaskIds;
  state.verificationTaskIds = verificationTaskIds;
  state.malformedTasks = malformedTasks;
  state.completedMilestoneIds = completedMilestoneIds;
  state.completedNonVerificationTaskIdsSinceVerification =
    completedNonVerificationTaskIdsSinceVerification;
}

export function createRequestTaskProgressState(params?: {
  readonly allowedMilestones?: readonly WorkflowRequestMilestone[];
}): RequestTaskProgressState {
  return {
    allowedMilestones: [...(params?.allowedMilestones ?? [])],
    tasksById: new Map<string, RequestTaskRecordState>(),
    nonDeletedTaskCount: 0,
    inProgressTaskIds: [],
    verificationTaskIds: [],
    malformedTasks: [],
    completedMilestoneIds: [],
    completedNonVerificationTaskIdsSinceVerification: [],
    nextCompletionOrdinal: 1,
    verificationAnchorOrdinal: 0,
  };
}

export function setAllowedRequestTaskMilestones(
  state: RequestTaskProgressState,
  milestones?: readonly WorkflowRequestMilestone[],
): void {
  state.allowedMilestones = normalizeWorkflowRequestMilestones(
    milestones ? { requiredMilestones: milestones } : undefined,
  );
  deriveState(state);
}

export function getRemainingRequestTaskMilestones(
  state: RequestTaskProgressState,
): readonly WorkflowRequestMilestone[] {
  const completed = new Set(state.completedMilestoneIds);
  return state.allowedMilestones.filter(
    (milestone) => !completed.has(milestone.id.trim()),
  );
}

export function noteRequestTaskVerifierAttempt(
  state: RequestTaskProgressState,
): void {
  state.verificationAnchorOrdinal = state.nextCompletionOrdinal - 1;
  deriveState(state);
}

export function observeRequestTaskToolRecord(
  state: RequestTaskProgressState,
  record: ToolCallLike,
): RequestTaskObservationResult | undefined {
  const parsed = parseTaskRuntimeRecord(record);
  if (!parsed) return undefined;

  const previous = state.tasksById.get(parsed.id);
  if (parsed.status === "deleted") {
    state.tasksById.delete(parsed.id);
  } else {
    const transitionedToCompleted =
      parsed.status === "completed" &&
      previous?.task.status !== "completed";
    const completedOrdinal = transitionedToCompleted
      ? state.nextCompletionOrdinal++
      : parsed.status === "completed"
        ? previous?.completedOrdinal
        : undefined;
    state.tasksById.set(parsed.id, {
      task: parsed,
      ...(completedOrdinal !== undefined ? { completedOrdinal } : {}),
    });
  }

  if (
    (record.name === "task.create" || record.name === "task.update") &&
    parsed.runtimeMetadata.verification
  ) {
    state.verificationAnchorOrdinal = state.nextCompletionOrdinal - 1;
  }

  deriveState(state);
  return {
    source: record.name as RequestTaskObservationResult["source"],
    nonDeletedTaskCount: state.nonDeletedTaskCount,
    inProgressTaskCount: state.inProgressTaskIds.length,
  };
}
