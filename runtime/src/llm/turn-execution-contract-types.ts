/**
 * Turn execution contract types — collapsed (Cut 1.2).
 *
 * The workflow-contract + completion-contract imports have been dropped
 * as part of deleting the planner subsystem. The runtime no longer
 * produces structured verification/completion contracts, so these
 * fields are preserved on the `TurnExecutionContract` shape as opaque
 * `unknown` slots to keep the call-site plumbing stable without the
 * type bleeding out of workflow/.
 *
 * @module
 */

import type { ArtifactTaskContract } from "./chat-executor-artifact-task.js";

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
  readonly verificationContract?: unknown;
  readonly completionContract?: unknown;
  readonly artifactTaskContract?: ArtifactTaskContract;
  readonly executionEnvelope?: unknown;
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
