/**
 * Workflow verification contract shape — opaque type stub (Cut 1.1).
 *
 * The verification-obligation derivation pipeline and all its reachability
 * helpers have been deleted. This module now exports only the contract
 * shape, which is still carried through progress snapshots and fingerprints
 * for consumer telemetry.
 *
 * @module
 */

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
