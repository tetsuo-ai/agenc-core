import type { LLMPipelineStopReason } from "../llm/policy.js";
import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import type { ImplementationCompletionContract } from "./completion-contract.js";
import {
  resolveWorkflowRequestCompletionStatus,
  type WorkflowRequestMilestone,
} from "./request-completion.js";
import type {
  PlannerVerificationSnapshot,
  WorkflowCompletionState,
} from "./completion-state.js";
import type { WorkflowVerificationContract } from "./verification-obligations.js";

export type WorkflowProgressRequirement =
  | "workflow_verifier_pass"
  | "build_verification"
  | "behavior_verification"
  | "review_verification"
  | "request_milestones";

interface WorkflowProgressEvidence {
  readonly requirement:
    | "build_verification"
    | "behavior_verification"
    | "review_verification";
  readonly summary: string;
  readonly observedAt: number;
}

export interface WorkflowProgressSnapshot {
  readonly completionState: WorkflowCompletionState;
  readonly stopReason: LLMPipelineStopReason;
  readonly stopReasonDetail?: string;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly contractFingerprint?: string;
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
  readonly requiredRequirements: readonly WorkflowProgressRequirement[];
  readonly satisfiedRequirements: readonly WorkflowProgressRequirement[];
  readonly remainingRequirements: readonly WorkflowProgressRequirement[];
  readonly requiredMilestones?: readonly WorkflowRequestMilestone[];
  readonly satisfiedMilestoneIds?: readonly string[];
  readonly remainingMilestones?: readonly WorkflowRequestMilestone[];
  readonly reusableEvidence: readonly WorkflowProgressEvidence[];
  readonly updatedAt: number;
}

interface CompletionProgressToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result: string;
  readonly isError: boolean;
}

interface EncodedVerificationMetadata {
  readonly category?: "build" | "behavior" | "review";
  readonly repoLocal?: boolean;
  readonly generatedHarness?: boolean;
  readonly command?: string;
  readonly cwd?: string;
  readonly path?: string;
}

export function deriveWorkflowProgressSnapshot(params: {
  readonly stopReason: LLMPipelineStopReason;
  readonly completionState: WorkflowCompletionState;
  readonly stopReasonDetail?: string;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly toolCalls: readonly CompletionProgressToolCall[];
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
  readonly completedRequestMilestoneIds?: readonly string[];
  readonly updatedAt: number;
  readonly contractFingerprint?: string;
  readonly verifier?: PlannerVerificationSnapshot;
}): WorkflowProgressSnapshot | undefined {
  const mergedContract = mergeVerificationContract({
    verificationContract: params.verificationContract,
    completionContract: params.completionContract,
  });
  const requiredRequirements = new Set<WorkflowProgressRequirement>();
  const requestCompletion = resolveWorkflowRequestCompletionStatus({
    contract: mergedContract?.requestCompletion,
    completedMilestoneIds: params.completedRequestMilestoneIds,
  });
  if (requestCompletion) {
    requiredRequirements.add("request_milestones");
  }

  const reusableEvidence: WorkflowProgressEvidence[] = [];
  for (const toolCall of params.toolCalls) {
    if (toolCall.isError) {
      continue;
    }
    const verification = decodeVerificationMetadata(toolCall.result);
    if (!verification?.category) {
      continue;
    }
    reusableEvidence.push({
      requirement: `${verification.category}_verification`,
      summary: buildEvidenceSummary(verification),
      observedAt: params.updatedAt,
    });
  }

  const satisfiedRequirements = new Set<WorkflowProgressRequirement>(
    reusableEvidence.map((entry) => entry.requirement),
  );
  if (requestCompletion && requestCompletion.remainingMilestones.length === 0) {
    satisfiedRequirements.add("request_milestones");
  }

  const remainingRequirements = [...requiredRequirements].filter(
    (requirement) => !satisfiedRequirements.has(requirement),
  );
  if (
    !mergedContract &&
    remainingRequirements.length === 0 &&
    params.completionState === "completed"
  ) {
    return undefined;
  }

  return {
    completionState: params.completionState,
    stopReason: params.stopReason,
    stopReasonDetail: params.stopReasonDetail,
    validationCode: params.validationCode,
    contractFingerprint:
      params.contractFingerprint ??
      buildProgressContractFingerprint({
        verificationContract: mergedContract,
        completionContract: mergedContract?.completionContract,
      }),
    verificationContract: mergedContract,
    completionContract: mergedContract?.completionContract,
    requiredRequirements: [...requiredRequirements],
    satisfiedRequirements: [...satisfiedRequirements],
    remainingRequirements,
    ...(requestCompletion
      ? {
        requiredMilestones: requestCompletion.requiredMilestones,
        satisfiedMilestoneIds: requestCompletion.satisfiedMilestoneIds,
        remainingMilestones: requestCompletion.remainingMilestones,
      }
      : {}),
    reusableEvidence,
    updatedAt: params.updatedAt,
  };
}

export function mergeWorkflowProgressSnapshots(params: {
  readonly previous?: WorkflowProgressSnapshot;
  readonly next?: WorkflowProgressSnapshot;
}): WorkflowProgressSnapshot | undefined {
  const previous = params.previous;
  const next = params.next;
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  const reusable = canReuseProgress(previous, next);
  const prior = reusable ? previous : undefined;
  const requiredRequirements = new Set<WorkflowProgressRequirement>([
    ...(prior?.requiredRequirements ?? []),
    ...next.requiredRequirements,
  ]);
  const satisfiedRequirements = new Set<WorkflowProgressRequirement>([
    ...(prior?.satisfiedRequirements ?? []),
    ...next.satisfiedRequirements,
  ]);
  const evidenceMap = new Map<string, WorkflowProgressEvidence>();
  for (const entry of [...(prior?.reusableEvidence ?? []), ...next.reusableEvidence]) {
    const key = `${entry.requirement}:${entry.summary}`;
    const existing = evidenceMap.get(key);
    if (!existing || existing.observedAt < entry.observedAt) {
      evidenceMap.set(key, entry);
    }
  }
  const remainingRequirements = [...requiredRequirements].filter(
    (requirement) => !satisfiedRequirements.has(requirement),
  );
  const requiredMilestones = mergeMilestoneLists(
    prior?.requiredMilestones,
    next.requiredMilestones,
  );
  const satisfiedMilestoneIds = [
    ...new Set([
      ...(prior?.satisfiedMilestoneIds ?? []),
      ...(next.satisfiedMilestoneIds ?? []),
    ]),
  ];
  const remainingMilestones = requiredMilestones.filter((milestone) =>
    !satisfiedMilestoneIds.includes(milestone.id)
  );
  const completionState = resolveMergedCompletionState({
    previous: prior,
    next,
    remainingRequirements,
  });

  return {
    completionState,
    stopReason: next.stopReason,
    stopReasonDetail: next.stopReasonDetail,
    validationCode: next.validationCode,
    contractFingerprint:
      next.contractFingerprint ?? prior?.contractFingerprint,
    verificationContract:
      next.verificationContract ?? prior?.verificationContract,
    completionContract:
      next.completionContract ?? prior?.completionContract,
    requiredRequirements: [...requiredRequirements],
    satisfiedRequirements: [...satisfiedRequirements],
    remainingRequirements,
    ...(requiredMilestones.length > 0
      ? {
        requiredMilestones,
        satisfiedMilestoneIds,
        remainingMilestones,
      }
      : {}),
    reusableEvidence: [...evidenceMap.values()].sort(
      (left, right) => left.observedAt - right.observedAt,
    ),
    updatedAt: next.updatedAt,
  };
}

function mergeVerificationContract(params: {
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
}): WorkflowVerificationContract | undefined {
  if (!params.verificationContract && !params.completionContract) {
    return undefined;
  }
  return {
    ...(params.verificationContract ?? {}),
    ...(params.completionContract
      ? { completionContract: params.completionContract }
      : {}),
  };
}

function decodeVerificationMetadata(
  rawResult: string,
): EncodedVerificationMetadata | undefined {
  try {
    const parsed = JSON.parse(rawResult) as { __agencVerification?: unknown };
    const raw = parsed?.__agencVerification;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return undefined;
    }
    return raw as EncodedVerificationMetadata;
  } catch {
    return undefined;
  }
}

function buildEvidenceSummary(
  verification: EncodedVerificationMetadata,
): string {
  if (typeof verification.command === "string" && verification.command.trim().length > 0) {
    return verification.command.trim();
  }
  if (typeof verification.path === "string" && verification.path.trim().length > 0) {
    return verification.path.trim();
  }
  if (typeof verification.cwd === "string" && verification.cwd.trim().length > 0) {
    return verification.cwd.trim();
  }
  return verification.generatedHarness ? "generated harness" : "repo-local verification";
}

function canReuseProgress(
  previous: WorkflowProgressSnapshot,
  next: WorkflowProgressSnapshot,
): boolean {
  const previousSignature =
    previous.contractFingerprint ?? buildProgressContractFingerprint(previous);
  const nextSignature =
    next.contractFingerprint ?? buildProgressContractFingerprint(next);
  if (!previousSignature || !nextSignature) {
    return false;
  }
  return previousSignature === nextSignature;
}

function buildProgressContractFingerprint(
  snapshot: Pick<
    WorkflowProgressSnapshot,
    "verificationContract" | "completionContract"
  >,
): string | undefined {
  if (!snapshot.verificationContract && !snapshot.completionContract) {
    return undefined;
  }
  const requestCompletion = snapshot.verificationContract?.requestCompletion;
  return JSON.stringify({
    workspaceRoot: snapshot.verificationContract?.workspaceRoot,
    inputArtifacts: snapshot.verificationContract?.inputArtifacts ?? [],
    requiredSourceArtifacts:
      snapshot.verificationContract?.requiredSourceArtifacts ?? [],
    targetArtifacts: snapshot.verificationContract?.targetArtifacts ?? [],
    acceptanceCriteria: snapshot.verificationContract?.acceptanceCriteria ?? [],
    verificationMode: snapshot.verificationContract?.verificationMode,
    completionContract: snapshot.completionContract,
    requestCompletion: requestCompletion
      ? {
        requiredMilestones: requestCompletion.requiredMilestones.map((milestone) => ({
          id: milestone.id,
          description: milestone.description,
        })),
      }
      : undefined,
  });
}

function mergeMilestoneLists(
  previous: readonly WorkflowRequestMilestone[] | undefined,
  next: readonly WorkflowRequestMilestone[] | undefined,
): WorkflowRequestMilestone[] {
  const merged = new Map<string, WorkflowRequestMilestone>();
  for (const milestone of [...(previous ?? []), ...(next ?? [])]) {
    if (typeof milestone.id !== "string" || milestone.id.trim().length === 0) {
      continue;
    }
    merged.set(milestone.id, milestone);
  }
  return [...merged.values()];
}

function resolveMergedCompletionState(params: {
  readonly previous?: WorkflowProgressSnapshot;
  readonly next: WorkflowProgressSnapshot;
  readonly remainingRequirements: readonly WorkflowProgressRequirement[];
}): WorkflowCompletionState {
  const latest = params.next.completionState;
  if (params.remainingRequirements.length === 0) {
    return latest;
  }
  if (latest === "blocked") {
    return "blocked";
  }
  if (latest === "completed") {
    return params.previous?.completionState === "blocked" ? "blocked" : "partial";
  }
  return latest;
}
