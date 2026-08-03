/** Public version-2 workflow result contract. */

import type { Sha256Digest } from "../eval-contract/index.js";
import type { WorkflowFailurePolicy } from "./workflow-manifest-schema.js";

export const WORKFLOW_RESULT_VERSION = 2;

export const WORKFLOW_STEP_OUTCOMES_V2 = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
  "unknown_outcome",
  "handoff_failed",
  "blocked_dependency_failed",
  "blocked_dependency_unknown",
] as const);

export const WORKFLOW_RUN_OUTCOMES_V2 = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "unknown_outcome",
] as const);

export const WORKFLOW_CANCELLATION_CAUSES = Object.freeze([
  "user_abort",
  "workflow_deadline",
  "daemon_shutdown",
  "fail_fast_peer",
] as const);

export type WorkflowStepOutcomeV2 =
  (typeof WORKFLOW_STEP_OUTCOMES_V2)[number];
export type WorkflowGroupOutcomeV2 = WorkflowStepOutcomeV2;
export type WorkflowRunOutcomeV2 =
  (typeof WORKFLOW_RUN_OUTCOMES_V2)[number];
export type WorkflowCancellationCause =
  (typeof WORKFLOW_CANCELLATION_CAUSES)[number];

export interface WorkflowCancellationV2 {
  readonly cause: WorkflowCancellationCause;
  readonly causal_step_id?: string;
  readonly sequence: number;
}

export interface WorkflowHandoffReferenceV2 {
  readonly artifact_id: string;
  readonly storage_ref: string;
  readonly digest: `sha256:${string}`;
  readonly byte_length: number;
  readonly token_count: number;
  readonly preview?: string;
  readonly preview_truncated: boolean;
}

export interface WorkflowStepResultV2 {
  readonly id: string;
  readonly ordinal: number;
  readonly outcome: WorkflowStepOutcomeV2;
  readonly task_name?: string;
  readonly duration_ms?: number;
  readonly error?: string;
  readonly cancellation?: WorkflowCancellationV2;
  readonly handoff?: WorkflowHandoffReferenceV2;
}

export interface WorkflowGroupResultV2 {
  readonly name: string;
  readonly outcome: WorkflowGroupOutcomeV2;
  readonly member_ids: readonly string[];
  readonly handoff?: WorkflowHandoffReferenceV2;
}

export interface WorkflowEffectiveLimitsV2 {
  readonly max_concurrency: number;
  readonly max_handoff_tokens: number;
  readonly failure_policy: WorkflowFailurePolicy;
}

export interface WorkflowSchedulerOperationCounts {
  readonly node_transitions: number;
  readonly edge_consumptions: number;
  readonly ready_enqueues: number;
  readonly ready_dequeues: number;
  readonly launches: number;
}

export interface WorkflowRunResultV2 {
  readonly workflow_result_version: typeof WORKFLOW_RESULT_VERSION;
  readonly run_id: string;
  readonly workflow_id: string;
  readonly manifest_format_version: 2;
  readonly manifest_digest: Sha256Digest;
  readonly outcome: WorkflowRunOutcomeV2;
  readonly effective_limits: WorkflowEffectiveLimitsV2;
  readonly steps: readonly WorkflowStepResultV2[];
  readonly groups: readonly WorkflowGroupResultV2[];
  readonly cancellation?: WorkflowCancellationV2;
  readonly operation_counts: WorkflowSchedulerOperationCounts;
}

export function isWorkflowStepOutcomeV2(
  value: unknown,
): value is WorkflowStepOutcomeV2 {
  return WORKFLOW_STEP_OUTCOMES_V2.some((candidate) => candidate === value);
}

export function isWorkflowRunOutcomeV2(
  value: unknown,
): value is WorkflowRunOutcomeV2 {
  return WORKFLOW_RUN_OUTCOMES_V2.some((candidate) => candidate === value);
}
