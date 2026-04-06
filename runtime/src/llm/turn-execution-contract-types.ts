import type { ArtifactTaskContract } from "./chat-executor-artifact-task.js";
import type { ExecutionEnvelope } from "../workflow/execution-envelope.js";
import type { ImplementationCompletionContract } from "../workflow/completion-contract.js";
import type { WorkflowVerificationContract } from "../workflow/verification-obligations.js";

export type TurnExecutionClass =
  | "dialogue"
  | "artifact_update"
  | "workflow_implementation"
  | "research"
  | "concordia_simulation";

export type TurnExecutionOwnerMode =
  | "none"
  | "artifact_owner"
  | "workflow_owner"
  | "research_owner"
  | "concordia_owner";

export type TurnDelegationPolicy =
  | "forbid"
  | "direct_owner"
  | "planner_allowed";

export interface TurnExecutionContract {
  readonly version: 1;
  readonly turnClass: TurnExecutionClass;
  readonly ownerMode: TurnExecutionOwnerMode;
  readonly workspaceRoot?: string;
  readonly sourceArtifacts: readonly string[];
  readonly targetArtifacts: readonly string[];
  readonly allowedToolNames?: readonly string[];
  readonly delegationPolicy: TurnDelegationPolicy;
  readonly verificationContract?: WorkflowVerificationContract;
  readonly completionContract?: ImplementationCompletionContract;
  readonly artifactTaskContract?: ArtifactTaskContract;
  readonly executionEnvelope?: ExecutionEnvelope;
  readonly contractFingerprint: string;
  readonly taskLineageId: string;
  readonly invalidReason?: string;
}

export interface ActiveTaskContext {
  readonly version: 1;
  readonly taskLineageId: string;
  readonly contractFingerprint: string;
  readonly turnClass: TurnExecutionClass;
  readonly ownerMode: TurnExecutionOwnerMode;
  readonly workspaceRoot?: string;
  readonly sourceArtifacts: readonly string[];
  readonly targetArtifacts: readonly string[];
  readonly displayArtifact?: string;
}
