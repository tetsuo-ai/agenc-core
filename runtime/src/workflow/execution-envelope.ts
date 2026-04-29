import {
  normalizeArtifactPaths,
  normalizeEnvelopeRoots,
  normalizeWorkspaceRoot,
} from "./path-normalization.js";
import type { ImplementationCompletionContract } from "./completion-contract.js";
import {
  canonicalizeExecutionCompletionContract,
  canonicalizeExecutionStepKind,
} from "./execution-intent.js";

export type ExecutionEnvelopeVersion = "v1";
export type ExecutionEffectClass =
  | "read_only"
  | "filesystem_write"
  | "filesystem_scaffold"
  | "shell"
  | "mixed";
export type ExecutionVerificationMode =
  | "none"
  | "grounded_read"
  | "conditional_mutation"
  | "mutation_required"
  | "deterministic_followup";
export type ExecutionStepKind =
  | "delegated_research"
  | "delegated_review"
  | "delegated_write"
  | "delegated_scaffold"
  | "delegated_validation";
const WORKFLOW_STEP_ROLES = [
  "reviewer",
  "writer",
  "validator",
  "researcher",
  "synthesizer",
] as const;
export type WorkflowStepRole = typeof WORKFLOW_STEP_ROLES[number];
const WORKFLOW_ARTIFACT_RELATION_TYPES = [
  "read_dependency",
  "write_owner",
  "verification_subject",
  "context_input",
  "handoff_artifact",
] as const;
type WorkflowArtifactRelationType =
  typeof WORKFLOW_ARTIFACT_RELATION_TYPES[number];
export interface WorkflowArtifactRelation {
  readonly relationType: WorkflowArtifactRelationType;
  readonly artifactPath: string;
}
export type ExecutionFallbackPolicy =
  | "continue_without_delegation"
  | "fail_request";
export type ExecutionResumePolicy = "stateless_retry" | "checkpoint_resume";
export type ExecutionApprovalProfile =
  | "inherit"
  | "read_only"
  | "filesystem_write"
  | "shell";
const EXECUTION_ENVELOPE_COMPATIBILITY_SOURCES = [
  "legacy_context_requirements",
  "legacy_persisted_checkpoint",
] as const;
type ExecutionEnvelopeCompatibilitySource =
  typeof EXECUTION_ENVELOPE_COMPATIBILITY_SOURCES[number];

export interface ExecutionEnvelope {
  readonly version?: ExecutionEnvelopeVersion;
  readonly workspaceRoot?: string;
  readonly allowedReadRoots?: readonly string[];
  readonly allowedWriteRoots?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly inputArtifacts?: readonly string[];
  readonly targetArtifacts?: readonly string[];
  readonly requiredSourceArtifacts?: readonly string[];
  readonly effectClass?: ExecutionEffectClass;
  readonly verificationMode?: ExecutionVerificationMode;
  readonly stepKind?: ExecutionStepKind;
  readonly role?: WorkflowStepRole;
  readonly artifactRelations?: readonly WorkflowArtifactRelation[];
  readonly completionContract?: ImplementationCompletionContract;
  readonly fallbackPolicy?: ExecutionFallbackPolicy;
  readonly resumePolicy?: ExecutionResumePolicy;
  readonly approvalProfile?: ExecutionApprovalProfile;
  readonly compatibilitySource?: ExecutionEnvelopeCompatibilitySource;
}

export function isMutationLikeVerificationMode(
  verificationMode: ExecutionVerificationMode | undefined,
): boolean {
  return (
    verificationMode === "mutation_required" ||
    verificationMode === "conditional_mutation"
  );
}

export function isCompatibilityExecutionEnvelope(
  envelope: ExecutionEnvelope | undefined,
): boolean {
  return (
    envelope?.compatibilitySource === "legacy_context_requirements" ||
    envelope?.compatibilitySource === "legacy_persisted_checkpoint"
  );
}

export function createExecutionEnvelope(params: {
  readonly workspaceRoot?: string | null;
  readonly allowedReadRoots?: readonly (string | undefined | null)[];
  readonly allowedWriteRoots?: readonly (string | undefined | null)[];
  readonly allowedTools?: readonly (string | undefined | null)[];
  readonly inputArtifacts?: readonly (string | undefined | null)[];
  readonly targetArtifacts?: readonly (string | undefined | null)[];
  readonly requiredSourceArtifacts?: readonly (string | undefined | null)[];
  readonly effectClass?: ExecutionEffectClass;
  readonly verificationMode?: ExecutionVerificationMode;
  readonly stepKind?: ExecutionStepKind;
  readonly role?: WorkflowStepRole;
  readonly artifactRelations?: readonly {
    readonly relationType?: string | null;
    readonly artifactPath?: string | null;
  }[];
  readonly completionContract?: ImplementationCompletionContract;
  readonly fallbackPolicy?: ExecutionFallbackPolicy;
  readonly resumePolicy?: ExecutionResumePolicy;
  readonly approvalProfile?: ExecutionApprovalProfile;
  readonly compatibilitySource?: ExecutionEnvelopeCompatibilitySource;
}): ExecutionEnvelope | undefined {
  const workspaceRoot = normalizeWorkspaceRoot(params.workspaceRoot);
  const allowedReadRoots = normalizeEnvelopeRoots(
    params.allowedReadRoots ?? [],
    workspaceRoot,
  );
  const allowedWriteRoots = normalizeEnvelopeRoots(
    params.allowedWriteRoots ?? [],
    workspaceRoot,
  );
  const allowedTools = [...new Set(
    (params.allowedTools ?? [])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )];
  const inputArtifacts = normalizeArtifactPaths(
    params.inputArtifacts ?? [],
    workspaceRoot,
  );
  const requiredSourceArtifacts = normalizeArtifactPaths(
    params.requiredSourceArtifacts ?? params.inputArtifacts ?? [],
    workspaceRoot,
  );
  const targetArtifacts = normalizeArtifactPaths(
    params.targetArtifacts ?? [],
    workspaceRoot,
  );
  const stepKind = canonicalizeExecutionStepKind({
    stepKind: params.stepKind,
    effectClass: params.effectClass,
    verificationMode: params.verificationMode,
    targetArtifacts,
  });
  const role = canonicalizeWorkflowStepRole({
    role: params.role,
    stepKind,
    effectClass: params.effectClass,
    verificationMode: params.verificationMode,
  });
  const artifactRelations = canonicalizeWorkflowArtifactRelations({
    workspaceRoot,
    artifactRelations: params.artifactRelations,
    inputArtifacts,
    requiredSourceArtifacts,
    targetArtifacts,
    stepKind,
    verificationMode: params.verificationMode,
    role,
  });
  const completionContract = canonicalizeExecutionCompletionContract({
    completionContract: params.completionContract,
    stepKind,
    effectClass: params.effectClass,
    verificationMode: params.verificationMode,
    targetArtifacts,
  });

  if (
    !workspaceRoot &&
    allowedReadRoots.length === 0 &&
    allowedWriteRoots.length === 0 &&
    allowedTools.length === 0 &&
    inputArtifacts.length === 0 &&
    requiredSourceArtifacts.length === 0 &&
    targetArtifacts.length === 0 &&
    !params.effectClass &&
    !params.verificationMode &&
    !stepKind &&
    !role &&
    artifactRelations.length === 0 &&
    !completionContract &&
    !params.fallbackPolicy &&
    !params.resumePolicy &&
    !params.approvalProfile
  ) {
    return undefined;
  }

  return {
    version: "v1",
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(allowedReadRoots.length > 0 ? { allowedReadRoots } : {}),
    ...(allowedWriteRoots.length > 0 ? { allowedWriteRoots } : {}),
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    ...(inputArtifacts.length > 0 ? { inputArtifacts } : {}),
    ...(requiredSourceArtifacts.length > 0 ? { requiredSourceArtifacts } : {}),
    ...(targetArtifacts.length > 0 ? { targetArtifacts } : {}),
    ...(params.effectClass ? { effectClass: params.effectClass } : {}),
    ...(params.verificationMode ? { verificationMode: params.verificationMode } : {}),
    ...(stepKind ? { stepKind } : {}),
    ...(role ? { role } : {}),
    ...(artifactRelations.length > 0 ? { artifactRelations } : {}),
    ...(completionContract
      ? {
        completionContract: {
          taskClass: completionContract.taskClass,
          placeholdersAllowed: completionContract.placeholdersAllowed,
          partialCompletionAllowed:
            completionContract.partialCompletionAllowed,
          ...(completionContract.placeholderTaxonomy
            ? {
              placeholderTaxonomy:
                completionContract.placeholderTaxonomy,
            }
            : {}),
        },
      }
      : {}),
    ...(params.fallbackPolicy ? { fallbackPolicy: params.fallbackPolicy } : {}),
    ...(params.resumePolicy ? { resumePolicy: params.resumePolicy } : {}),
    ...(params.approvalProfile ? { approvalProfile: params.approvalProfile } : {}),
    ...(params.compatibilitySource
      ? { compatibilitySource: params.compatibilitySource }
      : {}),
  };
}

function canonicalizeWorkflowStepRole(params: {
  readonly role?: string | null;
  readonly stepKind?: ExecutionStepKind;
  readonly effectClass?: ExecutionEffectClass;
  readonly verificationMode?: ExecutionVerificationMode;
}): WorkflowStepRole | undefined {
  if (typeof params.role === "string") {
    const normalized = params.role.trim().toLowerCase();
    if (
      (WORKFLOW_STEP_ROLES as readonly string[]).includes(normalized)
    ) {
      return normalized as WorkflowStepRole;
    }
  }

  if (
    params.stepKind === "delegated_write" ||
    params.stepKind === "delegated_scaffold" ||
    isMutationLikeVerificationMode(params.verificationMode) ||
    params.effectClass === "filesystem_write" ||
    params.effectClass === "filesystem_scaffold"
  ) {
    return "writer";
  }
  if (
    params.stepKind === "delegated_validation" ||
    params.verificationMode === "deterministic_followup"
  ) {
    return "validator";
  }
  if (params.stepKind === "delegated_review") {
    return "reviewer";
  }
  if (params.stepKind === "delegated_research") {
    return "researcher";
  }
  return undefined;
}

function normalizeWorkflowArtifactPath(
  artifactPath: string | undefined | null,
  workspaceRoot: string | undefined,
): string | undefined {
  if (typeof artifactPath !== "string") {
    return undefined;
  }
  return normalizeArtifactPaths([artifactPath], workspaceRoot)[0];
}

function dedupeWorkflowArtifactRelations(
  relations: readonly WorkflowArtifactRelation[],
): readonly WorkflowArtifactRelation[] {
  const seen = new Set<string>();
  const deduped: WorkflowArtifactRelation[] = [];
  for (const relation of relations) {
    const key = `${relation.relationType}::${relation.artifactPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(relation);
  }
  return deduped;
}

function canonicalizeWorkflowArtifactRelations(params: {
  readonly workspaceRoot?: string;
  readonly artifactRelations?: readonly {
    readonly relationType?: string | null;
    readonly artifactPath?: string | null;
  }[];
  readonly inputArtifacts?: readonly string[];
  readonly requiredSourceArtifacts?: readonly string[];
  readonly targetArtifacts?: readonly string[];
  readonly stepKind?: ExecutionStepKind;
  readonly verificationMode?: ExecutionVerificationMode;
  readonly role?: WorkflowStepRole;
}): readonly WorkflowArtifactRelation[] {
  const explicitRelations = (params.artifactRelations ?? [])
    .map((relation) => {
      const relationType =
        typeof relation.relationType === "string"
          ? relation.relationType.trim().toLowerCase()
          : "";
      if (
        !(WORKFLOW_ARTIFACT_RELATION_TYPES as readonly string[]).includes(
          relationType,
        )
      ) {
        return undefined;
      }
      const artifactPath = normalizeWorkflowArtifactPath(
        relation.artifactPath,
        params.workspaceRoot,
      );
      if (!artifactPath) {
        return undefined;
      }
      return {
        relationType: relationType as WorkflowArtifactRelationType,
        artifactPath,
      };
    })
    .filter(
      (relation): relation is WorkflowArtifactRelation => relation !== undefined,
    );
  if (explicitRelations.length > 0) {
    return dedupeWorkflowArtifactRelations(explicitRelations);
  }

  const inferred: WorkflowArtifactRelation[] = [];
  for (const artifactPath of params.inputArtifacts ?? []) {
    inferred.push({
      relationType: "context_input",
      artifactPath,
    });
  }
  for (const artifactPath of params.requiredSourceArtifacts ?? []) {
    inferred.push({
      relationType: "read_dependency",
      artifactPath,
    });
  }

  const targetRelationType: WorkflowArtifactRelationType =
    params.role === "writer" ||
      params.stepKind === "delegated_write" ||
      params.stepKind === "delegated_scaffold" ||
      isMutationLikeVerificationMode(params.verificationMode)
      ? "write_owner"
      : params.role === "validator" ||
          params.stepKind === "delegated_validation" ||
          params.verificationMode === "deterministic_followup"
        ? "verification_subject"
        : "verification_subject";
  for (const artifactPath of params.targetArtifacts ?? []) {
    inferred.push({
      relationType: targetRelationType,
      artifactPath,
    });
  }
  return dedupeWorkflowArtifactRelations(inferred);
}

export function resolveExecutionEnvelopeRole(
  envelope: ExecutionEnvelope | undefined,
): WorkflowStepRole | undefined {
  if (!envelope) {
    return undefined;
  }
  return canonicalizeWorkflowStepRole({
    role: envelope.role,
    stepKind: envelope.stepKind,
    effectClass: envelope.effectClass,
    verificationMode: envelope.verificationMode,
  });
}

export function resolveExecutionEnvelopeArtifactRelations(
  envelope: ExecutionEnvelope | undefined,
): readonly WorkflowArtifactRelation[] {
  if (!envelope) {
    return [];
  }
  return canonicalizeWorkflowArtifactRelations({
    workspaceRoot: envelope.workspaceRoot,
    artifactRelations: envelope.artifactRelations,
    inputArtifacts: envelope.inputArtifacts,
    requiredSourceArtifacts: envelope.requiredSourceArtifacts,
    targetArtifacts: envelope.targetArtifacts,
    stepKind: envelope.stepKind,
    verificationMode: envelope.verificationMode,
    role: resolveExecutionEnvelopeRole(envelope),
  });
}
