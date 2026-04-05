import { areDocumentationOnlyArtifacts } from "./artifact-paths.js";
import type { ImplementationCompletionContract } from "./completion-contract.js";
import type {
  ExecutionEffectClass,
  ExecutionStepKind,
  ExecutionVerificationMode,
} from "./execution-envelope.js";
import { isMutationLikeVerificationMode } from "./execution-envelope.js";

export function canonicalizeExecutionStepKind(params: {
  readonly stepKind?: ExecutionStepKind;
  readonly effectClass?: ExecutionEffectClass;
  readonly verificationMode?: ExecutionVerificationMode;
  readonly targetArtifacts?: readonly string[];
}): ExecutionStepKind | undefined {
  const stepKind = params.stepKind;
  if (!stepKind) {
    return undefined;
  }
  const ownsTargetArtifacts = (params.targetArtifacts?.length ?? 0) > 0;
  if (!ownsTargetArtifacts) {
    return stepKind;
  }
  const mutationLikeVerification = isMutationLikeVerificationMode(
    params.verificationMode,
  );
  const writeLikeEffect =
    params.effectClass === "filesystem_write" ||
    params.effectClass === "mixed" ||
    params.effectClass === "shell";
  const scaffoldLikeEffect = params.effectClass === "filesystem_scaffold";
  if (
    stepKind === "delegated_review" &&
    (mutationLikeVerification || writeLikeEffect || scaffoldLikeEffect)
  ) {
    return scaffoldLikeEffect ? "delegated_scaffold" : "delegated_write";
  }
  return stepKind;
}

export function inferCompatibilityCompletionContract(params: {
  readonly stepKind?: ExecutionStepKind;
  readonly effectClass?: ExecutionEffectClass;
  readonly verificationMode: ExecutionVerificationMode;
  readonly targetArtifacts: readonly string[];
}): ImplementationCompletionContract | undefined {
  const stepKind = canonicalizeExecutionStepKind(params);
  if (stepKind === "delegated_scaffold") {
    return {
      taskClass: "scaffold_allowed",
      placeholdersAllowed: true,
      partialCompletionAllowed: true,
      placeholderTaxonomy: "scaffold",
    };
  }
  if (
    stepKind === "delegated_review" ||
    stepKind === "delegated_validation"
  ) {
    return {
      taskClass: "review_required",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      placeholderTaxonomy: "implementation",
    };
  }
  if (
    stepKind === "delegated_write" ||
    (isMutationLikeVerificationMode(params.verificationMode) &&
      params.targetArtifacts.length > 0)
  ) {
    const placeholderTaxonomy = areDocumentationOnlyArtifacts(
      params.targetArtifacts,
    )
      ? "documentation"
      : "implementation";
    return {
      taskClass: "artifact_only",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      placeholderTaxonomy,
    };
  }
  return undefined;
}

export function canonicalizeExecutionCompletionContract(params: {
  readonly completionContract?: ImplementationCompletionContract;
  readonly stepKind?: ExecutionStepKind;
  readonly effectClass?: ExecutionEffectClass;
  readonly verificationMode?: ExecutionVerificationMode;
  readonly targetArtifacts?: readonly string[];
}): ImplementationCompletionContract | undefined {
  const completionContract = params.completionContract;
  if (!completionContract) {
    return undefined;
  }
  const targetArtifacts = params.targetArtifacts ?? [];
  const stepKind = canonicalizeExecutionStepKind(params);
  if (
    completionContract.taskClass === "review_required" &&
    stepKind &&
    stepKind !== "delegated_review" &&
    stepKind !== "delegated_validation"
  ) {
    return inferCompatibilityCompletionContract({
      stepKind,
      effectClass: params.effectClass,
      verificationMode:
        params.verificationMode ??
        (targetArtifacts.length > 0 ? "mutation_required" : "none"),
      targetArtifacts,
    });
  }
  if (
    completionContract.taskClass === "artifact_only" &&
    !completionContract.placeholderTaxonomy &&
    areDocumentationOnlyArtifacts(targetArtifacts)
  ) {
    return {
      ...completionContract,
      placeholderTaxonomy: "documentation",
    };
  }
  return completionContract;
}
