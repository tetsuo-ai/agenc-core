import type { WorkflowRequestCompletionContract } from "./request-completion.js";
import { normalizeWorkflowRequestMilestones } from "./request-completion.js";

export const REQUEST_TASK_RUNTIME_METADATA_KEY = "_runtime";

export interface NormalizedRequestTaskRuntimeMetadata {
  readonly hasRuntimeMetadata: boolean;
  readonly milestoneIds: readonly string[];
  readonly verification: boolean;
  readonly malformed: boolean;
  readonly errors: readonly string[];
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRequestTaskRuntimeMetadata(
  metadata: unknown,
): NormalizedRequestTaskRuntimeMetadata {
  if (!isPlainObject(metadata)) {
    return {
      hasRuntimeMetadata: false,
      milestoneIds: [],
      verification: false,
      malformed: false,
      errors: [],
    };
  }

  const rawRuntime = metadata[REQUEST_TASK_RUNTIME_METADATA_KEY];
  if (rawRuntime === undefined) {
    return {
      hasRuntimeMetadata: false,
      milestoneIds: [],
      verification: false,
      malformed: false,
      errors: [],
    };
  }

  if (!isPlainObject(rawRuntime)) {
    return {
      hasRuntimeMetadata: true,
      milestoneIds: [],
      verification: false,
      malformed: true,
      errors: [
        `metadata.${REQUEST_TASK_RUNTIME_METADATA_KEY} must be a plain object`,
      ],
    };
  }

  const errors: string[] = [];
  let verification = false;
  if (rawRuntime.verification !== undefined) {
    if (typeof rawRuntime.verification === "boolean") {
      verification = rawRuntime.verification;
    } else {
      errors.push(
        `metadata.${REQUEST_TASK_RUNTIME_METADATA_KEY}.verification must be a boolean`,
      );
    }
  }

  const milestoneIds: string[] = [];
  if (rawRuntime.milestoneIds !== undefined) {
    if (!Array.isArray(rawRuntime.milestoneIds)) {
      errors.push(
        `metadata.${REQUEST_TASK_RUNTIME_METADATA_KEY}.milestoneIds must be an array of unique non-empty strings`,
      );
    } else {
      const seen = new Set<string>();
      for (const entry of rawRuntime.milestoneIds) {
        if (typeof entry !== "string") {
          errors.push(
            `metadata.${REQUEST_TASK_RUNTIME_METADATA_KEY}.milestoneIds must contain only strings`,
          );
          continue;
        }
        const normalized = entry.trim();
        if (normalized.length === 0) {
          errors.push(
            `metadata.${REQUEST_TASK_RUNTIME_METADATA_KEY}.milestoneIds cannot contain empty strings`,
          );
          continue;
        }
        if (seen.has(normalized)) {
          errors.push(
            `metadata.${REQUEST_TASK_RUNTIME_METADATA_KEY}.milestoneIds cannot contain duplicates`,
          );
          continue;
        }
        seen.add(normalized);
        milestoneIds.push(normalized);
      }
    }
  }

  return {
    hasRuntimeMetadata: true,
    milestoneIds,
    verification,
    malformed: errors.length > 0,
    errors,
  };
}

export function buildRequestMilestoneRuntimeInstruction(
  contract?: WorkflowRequestCompletionContract,
): string | undefined {
  const milestones = normalizeWorkflowRequestMilestones(contract);
  if (milestones.length === 0) {
    return undefined;
  }

  const milestoneLines = milestones
    .map((milestone) => `- ${milestone.id}: ${milestone.description}`)
    .join("\n");
  return (
    "Request milestone contract:\n" +
    `${milestoneLines}\n` +
    "When you use task.create/task.update for this request, attach milestone ids in " +
    "`metadata._runtime.milestoneIds` and mark verification tasks with " +
    "`metadata._runtime.verification: true`. Keep one task in_progress until all request milestones are complete."
  );
}
