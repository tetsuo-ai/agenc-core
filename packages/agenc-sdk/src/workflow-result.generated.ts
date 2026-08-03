/** Generated public contract for event-driven workflow results. */

export const AGENC_WORKFLOW_RESULT_VERSION = 2 as const;
export const AGENC_WORKFLOW_STEP_OUTCOMES_V2 = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
  "unknown_outcome",
  "handoff_failed",
  "blocked_dependency_failed",
  "blocked_dependency_unknown",
] as const);
export const AGENC_WORKFLOW_RUN_OUTCOMES_V2 = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "unknown_outcome",
] as const);
export const AGENC_WORKFLOW_CANCELLATION_CAUSES = Object.freeze([
  "user_abort",
  "workflow_deadline",
  "daemon_shutdown",
  "fail_fast_peer",
] as const);
export const AGENC_DEFAULT_WORKFLOW_MAX_CONCURRENCY = 16 as const;
export const AGENC_MAX_WORKFLOW_MAX_CONCURRENCY = 64 as const;
export const AGENC_DEFAULT_WORKFLOW_MAX_HANDOFF_TOKENS = 8_192 as const;
export const AGENC_MAX_WORKFLOW_HANDOFF_TOKENS = 32_768 as const;
export const AGENC_MAX_WORKFLOW_FINAL_RESPONSE_BYTES = 4_194_304 as const;

export type WorkflowStepOutcomeV2 =
  (typeof AGENC_WORKFLOW_STEP_OUTCOMES_V2)[number];
export type WorkflowGroupOutcomeV2 = WorkflowStepOutcomeV2;
export type WorkflowRunOutcomeV2 =
  (typeof AGENC_WORKFLOW_RUN_OUTCOMES_V2)[number];
export type WorkflowCancellationCause =
  (typeof AGENC_WORKFLOW_CANCELLATION_CAUSES)[number];

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
  readonly failure_policy: "continue_independent" | "fail_fast";
}

export interface WorkflowSchedulerOperationCounts {
  readonly node_transitions: number;
  readonly edge_consumptions: number;
  readonly ready_enqueues: number;
  readonly ready_dequeues: number;
  readonly launches: number;
}

export interface WorkflowRunResultV2 {
  readonly workflow_result_version: 2;
  readonly run_id: string;
  readonly workflow_id: string;
  readonly manifest_format_version: 2;
  readonly manifest_digest: `sha256:${string}`;
  readonly outcome: WorkflowRunOutcomeV2;
  readonly effective_limits: WorkflowEffectiveLimitsV2;
  readonly steps: readonly WorkflowStepResultV2[];
  readonly groups: readonly WorkflowGroupResultV2[];
  readonly cancellation?: WorkflowCancellationV2;
  readonly operation_counts: WorkflowSchedulerOperationCounts;
}
