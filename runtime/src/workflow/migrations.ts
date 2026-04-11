import type {
  PipelineCheckpoint,
  Pipeline,
  PipelinePlannerStep,
  PipelinePlannerSubagentStep,
} from "./pipeline.js";
import type { ImplementationCompletionContract } from "./completion-contract.js";
import type { ExecutionEnvelope } from "./execution-envelope.js";
import {
  createExecutionEnvelope,
  isCompatibilityExecutionEnvelope,
} from "./execution-envelope.js";
import { buildCanonicalDelegatedFilesystemScope } from "./delegated-filesystem-scope.js";
import type { EffectRecord } from "./effects.js";
import type { TaskCheckpoint } from "../task/types.js";
import {
  LEGACY_UNVERSIONED_SCHEMA,
  RuntimeSchemaCompatibilityError,
  assertObjectRecord,
  createSchemaMigrationResult,
  extractSchemaVersion,
  type SchemaMigrationResult,
} from "./schema-version.js";

export const PIPELINE_CHECKPOINT_SCHEMA_VERSION = 1 as const;
const TASK_CHECKPOINT_SCHEMA_VERSION = 1 as const;
const EXECUTION_ENVELOPE_SCHEMA_VERSION = "v1" as const;

interface PersistedPipelineCheckpoint extends PipelineCheckpoint {
  readonly schemaVersion: typeof PIPELINE_CHECKPOINT_SCHEMA_VERSION;
}

interface PersistedTaskCheckpoint extends TaskCheckpoint {
  readonly schemaVersion: typeof TASK_CHECKPOINT_SCHEMA_VERSION;
}

function isSubagentStep(
  step: PipelinePlannerStep,
): step is PipelinePlannerSubagentStep {
  return step.stepType === "subagent_task";
}

function migrateExecutionEnvelope(
  value: unknown,
): SchemaMigrationResult<ExecutionEnvelope | undefined> {
  if (value === undefined || value === null) {
    return createSchemaMigrationResult({
      value: undefined,
      fromVersion: LEGACY_UNVERSIONED_SCHEMA,
      toVersion: EXECUTION_ENVELOPE_SCHEMA_VERSION,
    });
  }
  const raw = assertObjectRecord(value, "ExecutionEnvelope");
  const version = extractSchemaVersion(raw, "version");
  if (version !== undefined && version !== EXECUTION_ENVELOPE_SCHEMA_VERSION) {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "ExecutionEnvelope",
      receivedVersion: version,
      supportedVersions: [EXECUTION_ENVELOPE_SCHEMA_VERSION],
    });
  }
  const compatibilitySource =
    raw.compatibilitySource === "legacy_context_requirements"
      ? "legacy_context_requirements"
      : version === undefined
        ? "legacy_persisted_checkpoint"
        : undefined;
  const normalized = createExecutionEnvelope({
    workspaceRoot:
      typeof raw.workspaceRoot === "string" ? raw.workspaceRoot : undefined,
    allowedReadRoots: Array.isArray(raw.allowedReadRoots)
      ? (raw.allowedReadRoots as readonly (string | undefined | null)[])
      : undefined,
    allowedWriteRoots: Array.isArray(raw.allowedWriteRoots)
      ? (raw.allowedWriteRoots as readonly (string | undefined | null)[])
      : undefined,
    allowedTools: Array.isArray(raw.allowedTools)
      ? (raw.allowedTools as readonly (string | undefined | null)[])
      : undefined,
    inputArtifacts: Array.isArray(raw.inputArtifacts)
      ? (raw.inputArtifacts as readonly (string | undefined | null)[])
      : undefined,
    targetArtifacts: Array.isArray(raw.targetArtifacts)
      ? (raw.targetArtifacts as readonly (string | undefined | null)[])
      : undefined,
    requiredSourceArtifacts: Array.isArray(raw.requiredSourceArtifacts)
      ? (raw.requiredSourceArtifacts as readonly (string | undefined | null)[])
      : undefined,
    effectClass:
      typeof raw.effectClass === "string"
        ? (raw.effectClass as ExecutionEnvelope["effectClass"])
        : undefined,
    verificationMode:
      typeof raw.verificationMode === "string"
        ? (raw.verificationMode as ExecutionEnvelope["verificationMode"])
        : undefined,
    stepKind:
      typeof raw.stepKind === "string"
        ? (raw.stepKind as ExecutionEnvelope["stepKind"])
        : undefined,
    completionContract: parseCompletionContract(
      raw.completionContract,
    ),
    fallbackPolicy:
      typeof raw.fallbackPolicy === "string"
        ? (raw.fallbackPolicy as ExecutionEnvelope["fallbackPolicy"])
        : undefined,
    resumePolicy:
      typeof raw.resumePolicy === "string"
        ? (raw.resumePolicy as ExecutionEnvelope["resumePolicy"])
        : undefined,
    approvalProfile:
      typeof raw.approvalProfile === "string"
        ? (raw.approvalProfile as ExecutionEnvelope["approvalProfile"])
        : undefined,
    compatibilitySource,
  });
  return createSchemaMigrationResult({
    value: normalized,
    fromVersion: version ?? LEGACY_UNVERSIONED_SCHEMA,
    toVersion: EXECUTION_ENVELOPE_SCHEMA_VERSION,
  });
}

function parseCompletionContract(
  value: unknown,
): ImplementationCompletionContract | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as {
    taskClass?: unknown;
    placeholdersAllowed?: unknown;
    partialCompletionAllowed?: unknown;
    placeholderTaxonomy?: unknown;
  };
  if (
    typeof raw.taskClass !== "string" ||
    typeof raw.placeholdersAllowed !== "boolean" ||
    typeof raw.partialCompletionAllowed !== "boolean"
  ) {
    return undefined;
  }
  return {
    taskClass: raw.taskClass as ImplementationCompletionContract["taskClass"],
    placeholdersAllowed: raw.placeholdersAllowed,
    partialCompletionAllowed: raw.partialCompletionAllowed,
    ...(typeof raw.placeholderTaxonomy === "string"
      ? {
        placeholderTaxonomy:
          raw.placeholderTaxonomy as ImplementationCompletionContract["placeholderTaxonomy"],
      }
      : {}),
  };
}

function migratePlannerSteps(
  plannerSteps: readonly PipelinePlannerStep[] | undefined,
  plannerWorkspaceRoot?: string,
): {
  readonly plannerSteps: readonly PipelinePlannerStep[] | undefined;
  readonly requiresResumeRevalidation: boolean;
} {
  void plannerWorkspaceRoot;
  if (!plannerSteps) {
    return {
      plannerSteps: undefined,
      requiresResumeRevalidation: false,
    };
  }
  let requiresResumeRevalidation = false;
  const migratedSteps = plannerSteps.map((step) => {
    if (!isSubagentStep(step)) {
      return step;
    }
    if (step.executionContext === undefined) {
      return step;
    }
    const envelopeMigration = migrateExecutionEnvelope(step.executionContext);
    const migratedEnvelope = envelopeMigration.value;
    if (envelopeMigration.migrated) {
      requiresResumeRevalidation = true;
    }
    const liveEligibleEnvelope =
      migratedEnvelope && !isCompatibilityExecutionEnvelope(migratedEnvelope)
        ? migratedEnvelope
        : undefined;
    if (migratedEnvelope && isCompatibilityExecutionEnvelope(migratedEnvelope)) {
      requiresResumeRevalidation = true;
    }
    return liveEligibleEnvelope
      ? {
          ...step,
          executionContext: liveEligibleEnvelope,
        }
      : {
          ...step,
          executionContext: undefined,
        };
  });
  return {
    plannerSteps: migratedSteps,
    requiresResumeRevalidation,
  };
}

function normalizeLivePlannerExecutionEnvelope(
  value: unknown,
): ExecutionEnvelope | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const raw = assertObjectRecord(value, "ExecutionEnvelope");
  if (
    raw.compatibilitySource === "legacy_context_requirements" ||
    raw.compatibilitySource === "legacy_persisted_checkpoint"
  ) {
    return undefined;
  }
  const canonicalScope = buildCanonicalDelegatedFilesystemScope({
    workspaceRoot:
      typeof raw.workspaceRoot === "string" ? raw.workspaceRoot : undefined,
    allowedReadRoots: Array.isArray(raw.allowedReadRoots)
      ? (raw.allowedReadRoots as readonly (string | undefined | null)[])
      : undefined,
    allowedWriteRoots: Array.isArray(raw.allowedWriteRoots)
      ? (raw.allowedWriteRoots as readonly (string | undefined | null)[])
      : undefined,
    inputArtifacts: Array.isArray(raw.inputArtifacts)
      ? (raw.inputArtifacts as readonly (string | undefined | null)[])
      : undefined,
    requiredSourceArtifacts: Array.isArray(raw.requiredSourceArtifacts)
      ? (raw.requiredSourceArtifacts as readonly (string | undefined | null)[])
      : undefined,
    targetArtifacts: Array.isArray(raw.targetArtifacts)
      ? (raw.targetArtifacts as readonly (string | undefined | null)[])
      : undefined,
  });
  return createExecutionEnvelope({
    workspaceRoot: canonicalScope.workspaceRoot,
    allowedReadRoots: canonicalScope.allowedReadRoots,
    allowedWriteRoots: canonicalScope.allowedWriteRoots,
    allowedTools: Array.isArray(raw.allowedTools)
      ? (raw.allowedTools as readonly (string | undefined | null)[])
      : undefined,
    inputArtifacts: canonicalScope.inputArtifacts,
    requiredSourceArtifacts: canonicalScope.requiredSourceArtifacts,
    targetArtifacts: canonicalScope.targetArtifacts,
    effectClass:
      typeof raw.effectClass === "string"
        ? (raw.effectClass as ExecutionEnvelope["effectClass"])
        : undefined,
    verificationMode:
      typeof raw.verificationMode === "string"
        ? (raw.verificationMode as ExecutionEnvelope["verificationMode"])
        : undefined,
    stepKind:
      typeof raw.stepKind === "string"
        ? (raw.stepKind as ExecutionEnvelope["stepKind"])
        : undefined,
    completionContract: parseCompletionContract(raw.completionContract),
    fallbackPolicy:
      typeof raw.fallbackPolicy === "string"
        ? (raw.fallbackPolicy as ExecutionEnvelope["fallbackPolicy"])
        : undefined,
    resumePolicy:
      typeof raw.resumePolicy === "string"
        ? (raw.resumePolicy as ExecutionEnvelope["resumePolicy"])
        : undefined,
    approvalProfile:
      typeof raw.approvalProfile === "string"
        ? (raw.approvalProfile as ExecutionEnvelope["approvalProfile"])
        : undefined,
  });
}

export function canonicalizePipelinePlannerExecutionContexts(
  pipeline: Pipeline,
): Pipeline {
  return {
    ...pipeline,
    ...(pipeline.plannerSteps
      ? {
          plannerSteps: pipeline.plannerSteps.map((step) => {
            if (!isSubagentStep(step)) {
              return step;
            }
            if (step.executionContext === undefined) {
              return step;
            }
            const executionContext = normalizeLivePlannerExecutionEnvelope(
              step.executionContext,
            );
            return {
              ...step,
              executionContext,
            };
          }),
        }
      : {}),
  };
}

export function serializePipelineCheckpoint(
  checkpoint: PipelineCheckpoint,
): PersistedPipelineCheckpoint {
  return {
    ...checkpoint,
    schemaVersion: PIPELINE_CHECKPOINT_SCHEMA_VERSION,
    provenance: checkpoint.provenance ?? {
      schemaVersion: 1,
      source: "live_runtime",
      trust: "trusted",
      recordedAt: checkpoint.updatedAt,
    },
    pipeline: canonicalizePipelinePlannerExecutionContexts(checkpoint.pipeline),
  };
}

function parsePipelineCheckpointProvenance(
  value: unknown,
  updatedAt: number,
): PipelineCheckpoint["provenance"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const source =
    raw.source === "live_runtime" || raw.source === "migrated_checkpoint"
      ? raw.source
      : undefined;
  const trust =
    raw.trust === "trusted" || raw.trust === "needs_revalidation"
      ? raw.trust
      : undefined;
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.filter(
        (
          entry,
        ): entry is "schema_migrated" | "legacy_execution_envelope" =>
          entry === "schema_migrated" || entry === "legacy_execution_envelope",
      )
    : undefined;
  if (!source || !trust) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    source,
    trust,
    recordedAt:
      typeof raw.recordedAt === "number" ? raw.recordedAt : updatedAt,
    ...(reasons && reasons.length > 0 ? { reasons } : {}),
  };
}

export function migratePipelineCheckpoint(
  value: unknown,
): SchemaMigrationResult<PersistedPipelineCheckpoint> {
  const raw = assertObjectRecord(value, "PipelineCheckpoint");
  const version = extractSchemaVersion(raw, "schemaVersion");
  if (
    version !== undefined &&
    version !== PIPELINE_CHECKPOINT_SCHEMA_VERSION
  ) {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "PipelineCheckpoint",
      receivedVersion: version,
      supportedVersions: [PIPELINE_CHECKPOINT_SCHEMA_VERSION],
    });
  }
  const pipeline = raw.pipeline as Pipeline | undefined;
  if (
    typeof raw.pipelineId !== "string" ||
    !pipeline ||
    typeof raw.stepIndex !== "number" ||
    typeof raw.status !== "string" ||
    typeof raw.updatedAt !== "number" ||
    !raw.context ||
    typeof raw.context !== "object"
  ) {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "PipelineCheckpoint",
      receivedVersion: version ?? "invalid",
      supportedVersions: [PIPELINE_CHECKPOINT_SCHEMA_VERSION],
      reason: "missing required checkpoint fields",
    });
  }
  const plannerMigration = migratePlannerSteps(
    pipeline.plannerSteps,
    pipeline.plannerContext?.workspaceRoot,
  );
  const inheritedProvenance = parsePipelineCheckpointProvenance(
    raw.provenance,
    raw.updatedAt,
  );
  const provenanceReasons = new Set<
    "schema_migrated" | "legacy_execution_envelope"
  >(inheritedProvenance?.reasons ?? []);
  if (version === undefined) {
    provenanceReasons.add("schema_migrated");
  }
  if (plannerMigration.requiresResumeRevalidation) {
    provenanceReasons.add("legacy_execution_envelope");
  }
  const migrated = serializePipelineCheckpoint({
    pipelineId: raw.pipelineId,
    pipeline: {
      ...pipeline,
      ...(plannerMigration.plannerSteps
        ? { plannerSteps: plannerMigration.plannerSteps }
        : {}),
    },
    stepIndex: raw.stepIndex,
    context: raw.context as PipelineCheckpoint["context"],
    status: raw.status as PipelineCheckpoint["status"],
    updatedAt: raw.updatedAt,
    ...(provenanceReasons.size > 0 || inheritedProvenance?.trust === "needs_revalidation"
      ? {
          provenance: {
            schemaVersion: 1,
            source: "migrated_checkpoint",
            trust: "needs_revalidation",
            recordedAt: raw.updatedAt,
            reasons: [...provenanceReasons],
          },
        }
      : inheritedProvenance
        ? { provenance: inheritedProvenance }
        : undefined),
  });
  return createSchemaMigrationResult({
    value: migrated,
    fromVersion: version ?? LEGACY_UNVERSIONED_SCHEMA,
    toVersion: PIPELINE_CHECKPOINT_SCHEMA_VERSION,
  });
}

export function serializeTaskCheckpoint(
  checkpoint: TaskCheckpoint,
): PersistedTaskCheckpoint {
  return {
    ...checkpoint,
    schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION,
  };
}

function parseTaskExecutionResultAttestation(
  value: unknown,
  updatedAt: number,
): TaskCheckpoint["executionResultAttestation"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const source =
    raw.source === "live_runtime" ||
    raw.source === "migrated_checkpoint" ||
    raw.source === "unknown"
      ? raw.source
      : undefined;
  const trust =
    raw.trust === "trusted" || raw.trust === "needs_revalidation"
      ? raw.trust
      : undefined;
  const reason =
    raw.reason === "schema_migrated" ||
    raw.reason === "missing_attestation" ||
    raw.reason === "legacy_execution_result"
      ? raw.reason
      : undefined;
  if (!source || !trust) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    source,
    trust,
    recordedAt:
      typeof raw.recordedAt === "number" ? raw.recordedAt : updatedAt,
    ...(reason ? { reason } : {}),
  };
}

export function migrateTaskCheckpoint(
  value: unknown,
): SchemaMigrationResult<PersistedTaskCheckpoint> {
  const raw = assertObjectRecord(value, "TaskCheckpoint");
  const version = extractSchemaVersion(raw, "schemaVersion");
  if (version !== undefined && version !== TASK_CHECKPOINT_SCHEMA_VERSION) {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "TaskCheckpoint",
      receivedVersion: version,
      supportedVersions: [TASK_CHECKPOINT_SCHEMA_VERSION],
    });
  }
  if (
    typeof raw.taskPda !== "string" ||
    typeof raw.stage !== "string" ||
    typeof raw.createdAt !== "number" ||
    typeof raw.updatedAt !== "number"
  ) {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "TaskCheckpoint",
      receivedVersion: version ?? "invalid",
      supportedVersions: [TASK_CHECKPOINT_SCHEMA_VERSION],
      reason: "missing required checkpoint fields",
    });
  }
  const inheritedAttestation = parseTaskExecutionResultAttestation(
    raw.executionResultAttestation,
    raw.updatedAt,
  );
  const executionResultAttestation =
    raw.executionResult !== undefined
      ? inheritedAttestation ?? {
          schemaVersion: 1,
          source:
            version === undefined ? "migrated_checkpoint" : "unknown",
          trust: "needs_revalidation",
          recordedAt: raw.updatedAt,
          reason:
            version === undefined
              ? "schema_migrated"
              : "missing_attestation",
        }
      : undefined;
  return createSchemaMigrationResult({
    value: serializeTaskCheckpoint({
      taskPda: raw.taskPda,
      stage: raw.stage as TaskCheckpoint["stage"],
      claimResult: raw.claimResult as TaskCheckpoint["claimResult"],
      executionResult: raw.executionResult as TaskCheckpoint["executionResult"],
      executionResultAttestation,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    }),
    fromVersion: version ?? LEGACY_UNVERSIONED_SCHEMA,
    toVersion: TASK_CHECKPOINT_SCHEMA_VERSION,
  });
}

export function migrateEffectRecord(
  value: unknown,
): SchemaMigrationResult<EffectRecord> {
  const raw = assertObjectRecord(value, "EffectRecord");
  const version = extractSchemaVersion(raw, "version");
  if (version !== undefined && version !== "v1") {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "EffectRecord",
      receivedVersion: version,
      supportedVersions: ["v1"],
    });
  }
  if (
    typeof raw.id !== "string" ||
    typeof raw.idempotencyKey !== "string" ||
    typeof raw.toolCallId !== "string" ||
    typeof raw.toolName !== "string"
  ) {
    throw new RuntimeSchemaCompatibilityError({
      schemaName: "EffectRecord",
      receivedVersion: version ?? "invalid",
      supportedVersions: ["v1"],
      reason: "missing required effect fields",
    });
  }
  return createSchemaMigrationResult({
    value: {
      ...(raw as unknown as EffectRecord),
      version: "v1",
    },
    fromVersion: version ?? LEGACY_UNVERSIONED_SCHEMA,
    toVersion: "v1",
  });
}
