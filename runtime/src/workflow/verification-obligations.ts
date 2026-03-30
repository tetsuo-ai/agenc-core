import type { DelegationContractSpec } from "../utils/delegation-validation.js";
import { buildArtifactContract, type ArtifactContract } from "./artifact-contract.js";
import type {
  ImplementationCompletionContract,
  PlaceholderTaxonomy,
} from "./completion-contract.js";
import { areDocumentationOnlyArtifacts } from "./artifact-paths.js";
import type { WorkflowRequestCompletionContract } from "./request-completion.js";
import type {
  ExecutionStepKind,
  ExecutionVerificationMode,
  WorkflowStepRole,
} from "./execution-envelope.js";
import { canonicalizeWorkflowStepRole } from "./execution-envelope.js";
import { inferCompatibilityCompletionContract } from "./execution-intent.js";
import { criterionRequiresWorkspaceInspectionVerification } from "./workspace-inspection-evidence.js";

export interface WorkflowVerificationContract {
  readonly workspaceRoot?: string;
  readonly inputArtifacts?: readonly string[];
  readonly requiredSourceArtifacts?: readonly string[];
  readonly targetArtifacts?: readonly string[];
  readonly inheritedEvidence?: {
    readonly workspaceInspectionSatisfied?: boolean;
    readonly sourceSteps?: readonly string[];
  };
  readonly acceptanceCriteria?: readonly string[];
  readonly verificationMode?: ExecutionVerificationMode;
  readonly stepKind?: ExecutionStepKind;
  readonly role?: WorkflowStepRole;
  readonly completionContract?: ImplementationCompletionContract;
  readonly requestCompletion?: WorkflowRequestCompletionContract;
}

export interface VerificationObligations {
  readonly workspaceRoot?: string;
  readonly artifactContract: ArtifactContract;
  readonly acceptanceCriteria: readonly string[];
  readonly verificationMode: ExecutionVerificationMode;
  readonly stepKind?: ExecutionStepKind;
  readonly role?: WorkflowStepRole;
  readonly completionContract?: ImplementationCompletionContract;
  readonly placeholderTaxonomy: PlaceholderTaxonomy;
  readonly requiresBuildVerification: boolean;
  readonly requiresBehaviorVerification: boolean;
  readonly requiresReviewVerification: boolean;
  readonly requiresWorkspaceInspectionEvidence: boolean;
  readonly requiresMutationEvidence: boolean;
  readonly requiresSourceArtifactReads: boolean;
  readonly requiresTargetAuthorization: boolean;
  readonly allowsGroundedNoop: boolean;
  readonly placeholdersAllowed: boolean;
  readonly partialCompletionAllowed: boolean;
}

export function hasDelegationRuntimeVerificationContext(
  spec: DelegationContractSpec | undefined,
): boolean {
  if (!spec) {
    return false;
  }
  const executionContext = spec.executionContext;
  return Boolean(
    executionContext?.workspaceRoot ||
      executionContext?.verificationMode ||
      executionContext?.stepKind ||
      executionContext?.completionContract ||
      (executionContext?.inputArtifacts?.length ?? 0) > 0 ||
      (executionContext?.requiredSourceArtifacts?.length ?? 0) > 0 ||
      (executionContext?.targetArtifacts?.length ?? 0) > 0 ||
      (spec.ownedArtifacts?.length ?? 0) > 0,
  );
}

const BEHAVIOR_ACCEPTANCE_RE =
  /\b(?:behavior|behaviour|scenario|smoke|e2e|end-to-end|play(?:test)?|job control|pipeline|pipes|signal|interactive|runtime flow|cli behavior|how to play)\b/i;
const TEST_ACCEPTANCE_RE =
  /\b(?:test|tests|testing|spec|specs|vitest|jest|pytest|ctest|cargo test|go test|playwright)\b/i;
const BUILD_ACCEPTANCE_RE =
  /\b(?:build|compile|compiled|typecheck|lint|tsc|cmake|make|bundle)\b/i;

export function deriveVerificationObligations(
  input: DelegationContractSpec | WorkflowVerificationContract,
): VerificationObligations | undefined {
  const normalizedInput = normalizeVerificationContractInput(input);
  const workspaceRoot = normalizedInput.workspaceRoot?.trim();
  const requiredSourceArtifacts =
    normalizedInput.requiredSourceArtifacts ??
    normalizedInput.inputArtifacts ??
    [];
  const targetArtifacts =
    normalizedInput.targetArtifacts ??
    [];
  const acceptanceCriteria =
    normalizedInput.acceptanceCriteria?.filter((criterion) =>
      typeof criterion === "string" && criterion.trim().length > 0
    ) ?? [];

  if (
    !workspaceRoot &&
    requiredSourceArtifacts.length === 0 &&
    targetArtifacts.length === 0 &&
    acceptanceCriteria.length === 0 &&
    !normalizedInput.verificationMode &&
    !normalizedInput.stepKind &&
    !normalizedInput.completionContract
  ) {
    return undefined;
  }

  const stepKind = normalizedInput.stepKind;
  const verificationMode =
    normalizedInput.verificationMode ??
    inferVerificationMode(stepKind, requiredSourceArtifacts, targetArtifacts);
  const completionContract =
    normalizedInput.completionContract ??
    inferCompatibilityCompletionContract({
      stepKind,
      verificationMode,
      targetArtifacts,
    });
  const role = canonicalizeWorkflowStepRole({
    role: normalizedInput.role,
    stepKind,
    verificationMode,
  });
  const acceptanceCriteriaRequireBehavior =
    acceptanceCriteria.some((criterion) => criterionRequiresBehaviorVerification(criterion));
  const acceptanceCriteriaRequireBuild =
    acceptanceCriteria.some((criterion) => criterionRequiresBuildVerification(criterion));
  const acceptanceCriteriaRequireWorkspaceInspection =
    acceptanceCriteria.some((criterion) =>
      criterionRequiresWorkspaceInspectionVerification(criterion)
    );
  const requiresBuildVerification =
    completionContract?.taskClass === "build_required" ||
    completionContract?.taskClass === "behavior_required" ||
    acceptanceCriteriaRequireBuild ||
    acceptanceCriteriaRequireBehavior;
  const requiresBehaviorVerification =
    completionContract?.taskClass === "behavior_required" ||
    acceptanceCriteriaRequireBehavior;
  const requiresReviewVerification =
    completionContract?.taskClass === "review_required" ||
    role === "reviewer";
  const requiresWorkspaceInspectionEvidence =
    acceptanceCriteriaRequireWorkspaceInspection &&
    normalizedInput.inheritedEvidence?.workspaceInspectionSatisfied !== true;
  const requiresMutationEvidence =
    role === "reviewer" || completionContract?.taskClass === "review_required"
      ? false
      : completionContract
        ? verificationMode === "mutation_required" ||
          stepKind === "delegated_write" ||
          stepKind === "delegated_scaffold" ||
          targetArtifacts.length > 0
        : verificationMode === "mutation_required" ||
          stepKind === "delegated_write" ||
          stepKind === "delegated_scaffold";
  const placeholdersAllowed = completionContract?.placeholdersAllowed ?? false;
  const partialCompletionAllowed =
    completionContract?.partialCompletionAllowed ?? false;
  const placeholderTaxonomy =
    completionContract?.placeholderTaxonomy ??
    inferPlaceholderTaxonomy({
      completionContract,
      stepKind,
      targetArtifacts,
    });

  return {
    workspaceRoot,
    artifactContract: buildArtifactContract({
      requiredSourceArtifacts,
      targetArtifacts,
    }),
    acceptanceCriteria,
    verificationMode,
    stepKind,
    role,
    completionContract,
    placeholderTaxonomy,
    requiresBuildVerification,
    requiresBehaviorVerification,
    requiresReviewVerification,
    requiresWorkspaceInspectionEvidence,
    requiresMutationEvidence,
    requiresSourceArtifactReads:
      verificationMode === "grounded_read" ||
      requiresReviewVerification ||
      requiresWorkspaceInspectionEvidence ||
      requiresMutationEvidence ||
      requiredSourceArtifacts.length > 0,
    requiresTargetAuthorization: targetArtifacts.length > 0,
    allowsGroundedNoop:
      role !== "reviewer" &&
      targetArtifacts.length > 0,
    placeholdersAllowed,
    partialCompletionAllowed,
  };
}

function criterionRequiresBehaviorVerification(criterion: string): boolean {
  return (
    BEHAVIOR_ACCEPTANCE_RE.test(criterion) ||
    TEST_ACCEPTANCE_RE.test(criterion)
  );
}

function criterionRequiresBuildVerification(criterion: string): boolean {
  return BUILD_ACCEPTANCE_RE.test(criterion);
}

function normalizeVerificationContractInput(
  input: DelegationContractSpec | WorkflowVerificationContract,
): WorkflowVerificationContract {
  if (isDelegationContractSpec(input)) {
    const executionContext = input.executionContext;
    return {
      workspaceRoot: executionContext?.workspaceRoot,
      requiredSourceArtifacts:
        executionContext?.requiredSourceArtifacts ??
        executionContext?.inputArtifacts,
      inputArtifacts: executionContext?.inputArtifacts,
      targetArtifacts:
        executionContext?.targetArtifacts ??
        input.ownedArtifacts,
      inheritedEvidence: input.inheritedEvidence,
      acceptanceCriteria: input.acceptanceCriteria,
      verificationMode: executionContext?.verificationMode,
      stepKind: executionContext?.stepKind,
      role: executionContext?.role,
      completionContract: executionContext?.completionContract,
    };
  }
  return input;
}

function isDelegationContractSpec(
  input: DelegationContractSpec | WorkflowVerificationContract,
): input is DelegationContractSpec {
  return "executionContext" in input || "ownedArtifacts" in input;
}

function inferVerificationMode(
  stepKind: ExecutionStepKind | undefined,
  requiredSourceArtifacts: readonly string[],
  targetArtifacts: readonly string[],
): ExecutionVerificationMode {
  if (stepKind === "delegated_validation") {
    return "deterministic_followup";
  }
  if (stepKind === "delegated_write" || stepKind === "delegated_scaffold") {
    return "mutation_required";
  }
  if (targetArtifacts.length > 0) {
    return "mutation_required";
  }
  if (requiredSourceArtifacts.length > 0) {
    return "grounded_read";
  }
  return "none";
}

function inferPlaceholderTaxonomy(params: {
  readonly completionContract?: ImplementationCompletionContract;
  readonly stepKind?: ExecutionStepKind;
  readonly targetArtifacts?: readonly string[];
}): PlaceholderTaxonomy {
  if (params.completionContract?.placeholderTaxonomy) {
    return params.completionContract.placeholderTaxonomy;
  }
  if (
    params.completionContract?.taskClass === "scaffold_allowed" ||
    params.stepKind === "delegated_scaffold"
  ) {
    return "scaffold";
  }
  if (
    params.completionContract?.taskClass === "artifact_only" &&
    areDocumentationOnlyArtifacts(params.targetArtifacts ?? [])
  ) {
    return "documentation";
  }
  return "implementation";
}
