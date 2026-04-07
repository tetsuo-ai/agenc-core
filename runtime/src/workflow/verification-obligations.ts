/**
 * Workflow verification obligations — collapsed type stub (Cut 1.1).
 *
 * Replaces the previous 296-LOC verification-obligation derivation
 * pipeline. The planner subsystem that produced workflow contracts
 * has been deleted; the runtime no longer derives obligations from
 * acceptance criteria. The exported types are kept as opaque shapes
 * so consumer call sites still link.
 *
 * @module
 */

import type { DelegationContractSpec } from "../utils/delegation-validation.js";
import type { ImplementationCompletionContract } from "./completion-contract.js";
import type { WorkflowRequestCompletionContract } from "./request-completion.js";

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
  readonly verificationMode?: unknown;
  readonly stepKind?: unknown;
  readonly completionContract?: ImplementationCompletionContract;
  readonly requestCompletion?: WorkflowRequestCompletionContract;
  readonly role?: "reviewer" | "writer" | "validator" | "researcher" | "synthesizer";
}

export interface VerificationObligations {
  readonly workspaceRoot?: string;
  readonly artifactContract: unknown;
  readonly acceptanceCriteria: readonly string[];
  readonly verificationMode: unknown;
  readonly stepKind?: unknown;
  readonly completionContract?: unknown;
  readonly placeholderTaxonomy: string;
  readonly requiresBuildVerification: boolean;
  readonly requiresBehaviorVerification: boolean;
  readonly requiresReviewVerification: boolean;
  readonly requiresWorkspaceInspectionEvidence: boolean;
  readonly requiresMutationEvidence: boolean;
  readonly requiresSourceArtifactReads: boolean;
  readonly allowsGroundedNoop: boolean;
  readonly placeholdersAllowed: boolean;
  readonly partialCompletionAllowed: boolean;
}

export function hasDelegationRuntimeVerificationContext(
  _spec: DelegationContractSpec | undefined,
): boolean {
  return false;
}

export function deriveVerificationObligations(
  _input: DelegationContractSpec | WorkflowVerificationContract,
): VerificationObligations | undefined {
  return undefined;
}
