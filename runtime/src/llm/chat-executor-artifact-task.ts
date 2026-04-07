/**
 * Artifact task contract — collapsed stub (Cut 1.2).
 *
 * Replaces the previous 387-LOC artifact-task inference machinery
 * (operation-mode classification, grounding-mode selection, allowed
 * tool resolution, runtime-requirements synthesis). The planner
 * subsystem that consumed these contracts has been deleted, so
 * `resolveDirectArtifactTaskContract` always returns undefined and
 * `buildArtifactTaskRuntimeRequirements` returns an empty shape.
 *
 * @module
 */

import type { ChatExecuteParams } from "./chat-executor-types.js";
import type { PlannerPlanArtifactIntent } from "./chat-executor-planner.js";

export type ArtifactTaskOperationMode =
  | "review_only"
  | "review_and_update_if_needed"
  | "update_in_place"
  | "create_new_artifact"
  | "spec_to_implementation";

export type ArtifactTaskGroundingMode =
  | "artifact_only"
  | "artifact_plus_workspace";

export type ArtifactTaskDelegationPolicy = "direct_owner" | "planner_allowed";

export interface ArtifactTaskContract {
  readonly targetArtifacts: readonly string[];
  readonly sourceArtifacts: readonly string[];
  readonly workspaceRoot?: string;
  readonly operationMode: ArtifactTaskOperationMode;
  readonly groundingMode: ArtifactTaskGroundingMode;
  readonly delegationPolicy: ArtifactTaskDelegationPolicy;
  readonly allowedToolNames: readonly string[];
  readonly displayTargetArtifact: string;
  readonly artifactKind: "documentation";
  readonly acceptanceCriteria: readonly string[];
}

export interface ArtifactTaskRuntimeRequirements {
  readonly verificationContract: unknown;
  readonly completionContract: unknown;
  readonly executionEnvelope: unknown;
}

export function resolveMessageScopedWorkspaceRoot(_params: {
  readonly messageText: string;
  readonly workspaceRoot?: string | null;
  readonly explicitArtifactTargets?: readonly string[];
}): string | undefined {
  return undefined;
}

export function resolveDirectArtifactTaskContract(_params: {
  readonly messageText: string;
  readonly explicitArtifactTargets: readonly string[];
  readonly explicitSourceArtifactTargets: readonly string[];
  readonly explicitArtifactPlanIntent?: PlannerPlanArtifactIntent;
  readonly workspaceRoot?: string | null;
}): ArtifactTaskContract | undefined {
  return undefined;
}

export function buildArtifactTaskRuntimeRequirements(
  _contract: ArtifactTaskContract,
): ArtifactTaskRuntimeRequirements {
  return {
    verificationContract: undefined,
    completionContract: undefined,
    executionEnvelope: undefined,
  };
}

export function mergeArtifactTaskRequiredToolEvidence(params: {
  readonly base?: ChatExecuteParams["requiredToolEvidence"];
  readonly contract: ArtifactTaskContract;
}): ChatExecuteParams["requiredToolEvidence"] {
  return params.base;
}
