/**
 * Generated public metadata contract for durable workflow handoffs.
 * Keep synchronized with
 * `runtime/src/agents/workflow-handoff-artifact.v1.schema.json`.
 */

export const AGENC_WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION = 1 as const;
export const AGENC_WORKFLOW_HANDOFF_ARTIFACT_KIND =
  "workflow_handoff" as const;
export const AGENC_WORKFLOW_HANDOFF_MINIMUM_READER_RUNTIME = "0.13.0" as const;
export const AGENC_MAX_WORKFLOW_HANDOFF_ARTIFACT_BYTES = 16_777_216 as const;
export const AGENC_MAX_WORKFLOW_STEP_RESULT_TOKENS = 131_072 as const;
export const AGENC_MAX_WORKFLOW_STEP_PREVIEW_BYTES = 2_048 as const;

export interface WorkflowHandoffOwner {
  readonly run_id: string;
  readonly workflow_id: string;
  readonly producer_step_id: string;
}

export interface WorkflowHandoffArtifact {
  readonly format_version: 1;
  readonly kind: "workflow_handoff";
  readonly minimum_reader_runtime: "0.13.0";
  readonly artifact_id: string;
  readonly owner: WorkflowHandoffOwner;
  readonly digest: `sha256:${string}`;
  readonly byte_length: number;
  readonly token_count: number;
  readonly media_type: "text/plain";
  readonly encoding: "utf-8";
  readonly storage_ref: string;
  readonly created_at_ms: number;
  readonly committed_at_ms: number;
  readonly commit_sequence: number;
  readonly preview: string;
  readonly preview_truncated: boolean;
}
