/**
 * Turn execution contract helpers.
 *
 * Restores the minimum workflow-owned contract plumbing needed for
 * top-level execution to preserve active-task lineage and reuse the same
 * artifact-evidence validation path delegated children already obey.
 *
 * @module
 */

import { createHash } from "node:crypto";

import type { ChatExecuteParams } from "./chat-executor-types.js";
import type {
  ActiveTaskContext,
  TurnExecutionContract,
} from "./turn-execution-contract-types.js";
import type { ImplementationCompletionContract } from "../workflow/completion-contract.js";
import {
  createExecutionEnvelope,
  type ExecutionEnvelope,
} from "../workflow/execution-envelope.js";
import {
  normalizeArtifactPaths,
  normalizeWorkspaceRoot,
} from "../workflow/path-normalization.js";
import type { WorkflowVerificationContract } from "../workflow/verification-obligations.js";
import { areDocumentationOnlyArtifacts } from "../workflow/artifact-paths.js";

function stableHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

function buildDefaultContract(): TurnExecutionContract {
  const fingerprint = stableHash({ shape: "default", t: 0 });
  return {
    version: 1,
    turnClass: "dialogue",
    ownerMode: "none",
    sourceArtifacts: [],
    targetArtifacts: [],
    delegationPolicy: "planner_allowed",
    contractFingerprint: fingerprint,
    taskLineageId: fingerprint,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asExecutionEnvelope(value: unknown): ExecutionEnvelope | undefined {
  return isRecord(value) ? value as ExecutionEnvelope : undefined;
}

function asWorkflowVerificationContract(
  value: unknown,
): WorkflowVerificationContract | undefined {
  return isRecord(value) ? value as WorkflowVerificationContract : undefined;
}

function asCompletionContract(
  value: unknown,
): ImplementationCompletionContract | undefined {
  return isRecord(value)
    ? value as unknown as ImplementationCompletionContract
    : undefined;
}

function buildCarryoverExecutionEnvelope(
  activeTaskContext: ActiveTaskContext | undefined,
): ExecutionEnvelope | undefined {
  if (!activeTaskContext) return undefined;
  if (activeTaskContext.turnClass !== "workflow_implementation") return undefined;
  if (activeTaskContext.ownerMode !== "workflow_owner") return undefined;
  if ((activeTaskContext.targetArtifacts?.length ?? 0) === 0) return undefined;

  const workspaceRoot = normalizeWorkspaceRoot(activeTaskContext.workspaceRoot);
  const sourceArtifacts = normalizeArtifactPaths(
    activeTaskContext.sourceArtifacts ?? [],
    workspaceRoot,
  );
  const targetArtifacts = normalizeArtifactPaths(
    activeTaskContext.targetArtifacts ?? [],
    workspaceRoot,
  );
  if (targetArtifacts.length === 0) return undefined;

  const docsOnlyTargets = areDocumentationOnlyArtifacts(targetArtifacts);

  return createExecutionEnvelope({
    workspaceRoot,
    allowedReadRoots: workspaceRoot ? [workspaceRoot] : [],
    allowedWriteRoots: workspaceRoot ? [workspaceRoot] : [],
    inputArtifacts: sourceArtifacts,
    requiredSourceArtifacts: sourceArtifacts,
    targetArtifacts,
    effectClass: "filesystem_write",
    verificationMode: docsOnlyTargets
      ? "conditional_mutation"
      : "mutation_required",
    stepKind: "delegated_write",
    role: "writer",
    completionContract: {
      taskClass: "artifact_only",
      placeholdersAllowed: false,
      partialCompletionAllowed: docsOnlyTargets,
    },
  });
}

function buildVerificationContractFromEnvelope(
  envelope: ExecutionEnvelope | undefined,
): WorkflowVerificationContract | undefined {
  if (!envelope) return undefined;
  if (
    !envelope.workspaceRoot &&
    (envelope.inputArtifacts?.length ?? 0) === 0 &&
    (envelope.requiredSourceArtifacts?.length ?? 0) === 0 &&
    (envelope.targetArtifacts?.length ?? 0) === 0 &&
    !envelope.completionContract &&
    !envelope.verificationMode &&
    !envelope.stepKind &&
    !envelope.role
  ) {
    return undefined;
  }

  return {
    ...(envelope.workspaceRoot ? { workspaceRoot: envelope.workspaceRoot } : {}),
    ...(envelope.inputArtifacts ? { inputArtifacts: envelope.inputArtifacts } : {}),
    ...(envelope.requiredSourceArtifacts
      ? { requiredSourceArtifacts: envelope.requiredSourceArtifacts }
      : {}),
    ...(envelope.targetArtifacts ? { targetArtifacts: envelope.targetArtifacts } : {}),
    ...(envelope.verificationMode
      ? { verificationMode: envelope.verificationMode }
      : {}),
    ...(envelope.stepKind ? { stepKind: envelope.stepKind } : {}),
    ...(envelope.completionContract
      ? { completionContract: envelope.completionContract }
      : {}),
    ...(envelope.role ? { role: envelope.role } : {}),
  };
}

interface ResolvedWorkflowEvidence {
  readonly workspaceRoot?: string;
  readonly sourceArtifacts: readonly string[];
  readonly targetArtifacts: readonly string[];
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
  readonly executionEnvelope?: ExecutionEnvelope;
}

export function resolveWorkflowEvidenceFromRequiredToolEvidence(params: {
  readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
  readonly runtimeContext?: ChatExecuteParams["runtimeContext"];
}): ResolvedWorkflowEvidence {
  const activeTaskContext = params.runtimeContext?.activeTaskContext;
  const explicitVerification = params.requiredToolEvidence?.verificationContract;
  const explicitEnvelope = params.requiredToolEvidence?.executionEnvelope;
  const synthesizedCarryoverEnvelope =
    explicitVerification || explicitEnvelope
      ? undefined
      : buildCarryoverExecutionEnvelope(activeTaskContext);
  const executionEnvelope = explicitEnvelope ?? synthesizedCarryoverEnvelope;
  const verificationContract =
    explicitVerification ?? buildVerificationContractFromEnvelope(executionEnvelope);
  const workspaceRoot = normalizeWorkspaceRoot(
    verificationContract?.workspaceRoot ??
      executionEnvelope?.workspaceRoot ??
      params.runtimeContext?.workspaceRoot ??
      activeTaskContext?.workspaceRoot,
  );
  const sourceArtifacts = normalizeArtifactPaths(
    [
      ...(verificationContract?.requiredSourceArtifacts ??
        verificationContract?.inputArtifacts ??
        []),
      ...(executionEnvelope?.requiredSourceArtifacts ??
        executionEnvelope?.inputArtifacts ??
        []),
    ],
    workspaceRoot,
  );
  const targetArtifacts = normalizeArtifactPaths(
    [
      ...(verificationContract?.targetArtifacts ?? []),
      ...(executionEnvelope?.targetArtifacts ?? []),
    ],
    workspaceRoot,
  );
  const completionContract =
    params.requiredToolEvidence?.completionContract ??
    verificationContract?.completionContract ??
    executionEnvelope?.completionContract;

  return {
    workspaceRoot,
    sourceArtifacts,
    targetArtifacts,
    verificationContract,
    completionContract,
    executionEnvelope,
  };
}

export function resolveTurnExecutionContract(params: {
  readonly message: ChatExecuteParams["message"];
  readonly runtimeContext?: ChatExecuteParams["runtimeContext"];
  readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
}): TurnExecutionContract {
  void params.message;
  const fallback = buildDefaultContract();
  const activeTaskContext = params.runtimeContext?.activeTaskContext;
  const workflowEvidence = resolveWorkflowEvidenceFromRequiredToolEvidence({
    requiredToolEvidence: params.requiredToolEvidence,
    runtimeContext: params.runtimeContext,
  });

  const workspaceRoot =
    workflowEvidence.workspaceRoot ??
    normalizeWorkspaceRoot(activeTaskContext?.workspaceRoot);
  const sourceArtifacts = normalizeArtifactPaths(
    [
      ...(activeTaskContext?.sourceArtifacts ?? []),
      ...workflowEvidence.sourceArtifacts,
    ],
    workspaceRoot,
  );
  const targetArtifacts = normalizeArtifactPaths(
    [
      ...(activeTaskContext?.targetArtifacts ?? []),
      ...workflowEvidence.targetArtifacts,
    ],
    workspaceRoot,
  );

  const hasWorkflowOwnership =
    (
      workflowEvidence.verificationContract !== undefined ||
      workflowEvidence.completionContract !== undefined ||
      workflowEvidence.executionEnvelope !== undefined
    ) &&
    targetArtifacts.length > 0;

  if (!activeTaskContext && !hasWorkflowOwnership) {
    return fallback;
  }

  const turnClass = hasWorkflowOwnership
    ? "workflow_implementation"
    : activeTaskContext?.turnClass ?? fallback.turnClass;
  const ownerMode = hasWorkflowOwnership
    ? "workflow_owner"
    : activeTaskContext?.ownerMode ?? fallback.ownerMode;
  const delegationPolicy =
    ownerMode === "workflow_owner" || ownerMode === "artifact_owner"
      ? "direct_owner"
      : fallback.delegationPolicy;
  const contractPayload = {
    turnClass,
    ownerMode,
    workspaceRoot,
    sourceArtifacts,
    targetArtifacts,
    verificationContract: workflowEvidence.verificationContract,
    completionContract: workflowEvidence.completionContract,
    executionEnvelope: workflowEvidence.executionEnvelope,
  };
  const contractFingerprint =
    activeTaskContext?.contractFingerprint ?? stableHash(contractPayload);
  const taskLineageId =
    activeTaskContext?.taskLineageId ?? contractFingerprint;

  return {
    version: 1,
    turnClass,
    ownerMode,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    sourceArtifacts,
    targetArtifacts,
    delegationPolicy,
    ...(workflowEvidence.verificationContract
      ? { verificationContract: workflowEvidence.verificationContract }
      : {}),
    ...(workflowEvidence.completionContract
      ? { completionContract: workflowEvidence.completionContract }
      : {}),
    ...(workflowEvidence.executionEnvelope
      ? { executionEnvelope: workflowEvidence.executionEnvelope }
      : {}),
    contractFingerprint,
    taskLineageId,
  };
}

export function mergeTurnExecutionRequiredToolEvidence(params: {
  readonly base?: ChatExecuteParams["requiredToolEvidence"];
  readonly turnExecutionContract: TurnExecutionContract;
}): ChatExecuteParams["requiredToolEvidence"] {
  const verificationContract = asWorkflowVerificationContract(
    params.turnExecutionContract.verificationContract,
  );
  const completionContract = asCompletionContract(
    params.turnExecutionContract.completionContract,
  );
  const executionEnvelope = asExecutionEnvelope(
    params.turnExecutionContract.executionEnvelope,
  );

  if (
    !params.base &&
    !verificationContract &&
    !completionContract &&
    !executionEnvelope
  ) {
    return undefined;
  }

  return {
    maxCorrectionAttempts: Math.max(
      0,
      Math.floor(params.base?.maxCorrectionAttempts ?? 1),
    ),
    ...(params.base?.delegationSpec
      ? { delegationSpec: params.base.delegationSpec }
      : {}),
    ...(params.base?.unsafeBenchmarkMode === true
      ? { unsafeBenchmarkMode: true }
      : {}),
    ...((params.base?.verificationContract ?? verificationContract)
      ? {
        verificationContract:
          params.base?.verificationContract ?? verificationContract,
      }
      : {}),
    ...((params.base?.completionContract ?? completionContract)
      ? {
        completionContract:
          params.base?.completionContract ?? completionContract,
      }
      : {}),
    ...((params.base?.executionEnvelope ?? executionEnvelope)
      ? {
        executionEnvelope:
          params.base?.executionEnvelope ?? executionEnvelope,
      }
      : {}),
  };
}

export function deriveActiveTaskContext(
  contract: TurnExecutionContract,
): ActiveTaskContext {
  return {
    version: 1,
    taskLineageId: contract.taskLineageId,
    contractFingerprint: contract.contractFingerprint,
    turnClass: contract.turnClass,
    ownerMode: contract.ownerMode,
    workspaceRoot: contract.workspaceRoot,
    sourceArtifacts: contract.sourceArtifacts,
    targetArtifacts: contract.targetArtifacts,
  };
}

/**
 * Synthetic "dialogue" contract for runtime-native tool invocations and
 * benchmark harnesses that do not go through the LLM adapter. Uses
 * `delegationPolicy: "forbid"` to short-circuit delegation heuristics.
 */
export function createSyntheticDialogueTurnExecutionContract(): TurnExecutionContract {
  return {
    version: 1 as const,
    turnClass: "dialogue" as const,
    ownerMode: "none" as const,
    sourceArtifacts: [],
    targetArtifacts: [],
    delegationPolicy: "forbid" as const,
    contractFingerprint: "synthetic-dialogue-contract",
    taskLineageId: "synthetic-dialogue-task",
  };
}
