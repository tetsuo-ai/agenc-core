import type { WorkflowRequestCompletionContract } from "./request-completion.js";
import { normalizeWorkflowRequestMilestones } from "./request-completion.js";
import type {
  AcceptanceProbeCategory,
} from "../gateway/subagent-orchestrator-types.js";
import type { VerifierProfileKind } from "../gateway/verifier-probes.js";

export const REQUEST_TASK_RUNTIME_METADATA_KEY = "_runtime";

export interface NormalizedRequestTaskRuntimeMetadata {
  readonly hasRuntimeMetadata: boolean;
  readonly milestoneIds: readonly string[];
  readonly verification: boolean;
  readonly verifierProfiles: readonly VerifierProfileKind[];
  readonly verifierProbeCategories: readonly AcceptanceProbeCategory[];
  readonly malformed: boolean;
  readonly errors: readonly string[];
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVerifierProfileKind(value: string): value is VerifierProfileKind {
  return (
    value === "generic" ||
    value === "cli" ||
    value === "api" ||
    value === "browser" ||
    value === "infra"
  );
}

function isAcceptanceProbeCategory(
  value: string,
): value is AcceptanceProbeCategory {
  return (
    value === "build" ||
    value === "typecheck" ||
    value === "lint" ||
    value === "test" ||
    value === "smoke" ||
    value === "api_smoke" ||
    value === "browser_e2e" ||
    value === "infra_validate"
  );
}

export function normalizeRequestTaskRuntimeMetadata(
  metadata: unknown,
): NormalizedRequestTaskRuntimeMetadata {
  if (!isPlainObject(metadata)) {
    return {
      hasRuntimeMetadata: false,
      milestoneIds: [],
      verification: false,
      verifierProfiles: [],
      verifierProbeCategories: [],
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
      verifierProfiles: [],
      verifierProbeCategories: [],
      malformed: false,
      errors: [],
    };
  }

  if (!isPlainObject(rawRuntime)) {
    return {
      hasRuntimeMetadata: true,
      milestoneIds: [],
      verification: false,
      verifierProfiles: [],
      verifierProbeCategories: [],
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

  const verifierProfiles: VerifierProfileKind[] = [];
  if (rawRuntime.verifierProfiles !== undefined) {
    if (!Array.isArray(rawRuntime.verifierProfiles)) {
      errors.push(
        `metadata.${REQUEST_TASK_RUNTIME_METADATA_KEY}.verifierProfiles must be an array of verifier profile ids`,
      );
    } else {
      const seen = new Set<VerifierProfileKind>();
      for (const entry of rawRuntime.verifierProfiles) {
        if (typeof entry !== "string" || !isVerifierProfileKind(entry.trim())) {
          errors.push(
            `metadata.${REQUEST_TASK_RUNTIME_METADATA_KEY}.verifierProfiles must contain only known verifier profile ids`,
          );
          continue;
        }
        const normalized = entry.trim() as VerifierProfileKind;
        if (seen.has(normalized)) {
          continue;
        }
        seen.add(normalized);
        verifierProfiles.push(normalized);
      }
    }
  }

  const verifierProbeCategories: AcceptanceProbeCategory[] = [];
  if (rawRuntime.verifierProbeCategories !== undefined) {
    if (!Array.isArray(rawRuntime.verifierProbeCategories)) {
      errors.push(
        `metadata.${REQUEST_TASK_RUNTIME_METADATA_KEY}.verifierProbeCategories must be an array of verification categories`,
      );
    } else {
      const seen = new Set<AcceptanceProbeCategory>();
      for (const entry of rawRuntime.verifierProbeCategories) {
        if (
          typeof entry !== "string" ||
          !isAcceptanceProbeCategory(entry.trim())
        ) {
          errors.push(
            `metadata.${REQUEST_TASK_RUNTIME_METADATA_KEY}.verifierProbeCategories must contain only known verification categories`,
          );
          continue;
        }
        const normalized = entry.trim() as AcceptanceProbeCategory;
        if (seen.has(normalized)) {
          continue;
        }
        seen.add(normalized);
        verifierProbeCategories.push(normalized);
      }
    }
  }

  return {
    hasRuntimeMetadata: true,
    milestoneIds,
    verification,
    verifierProfiles,
    verifierProbeCategories,
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
    "`metadata._runtime.verification: true`."
  );
}
