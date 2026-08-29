/**
 * Durable compaction transaction contracts.
 *
 * Keep every resource bound here. Compaction is fed by untrusted transcripts
 * and provider output, so an unnamed default at a call site is a security bug.
 */

import type { AgentInvocationChannelMetadata } from "../../contracts/agent-invocation-envelope.js";
import type { ToolResultIntegrity } from "../../session/tool-result-integrity.js";
import type { RuntimeMessage } from "./types.js";
import type { CompactionHistoryMarkerV1 } from "../../session/compaction-history-marker.js";

export const COMPACTION_EVENT_FORMAT_VERSION = 1 as const;
/** Minimum reader stamped by writers of the current event format. */
export const COMPACTION_MINIMUM_READER_RUNTIME = "0.14.0" as const;
export const COMPACTION_SUMMARY_VERSION = 1 as const;
export const COMPACTION_SUMMARY_KIND = "compaction_summary" as const;
export const COMPACTION_BOUNDARY_MARKER_V1 =
  "agenc_compaction_boundary_v1:" as const;
export const COMPACTION_CONTEXT_KIND_V1 =
  "agenc_compaction_context_v1" as const;
export const COMPACTION_SUMMARY_DIGEST_DOMAIN =
  "agenc.compaction-summary.v1\0" as const;
export const COMPACTION_SOURCE_DIGEST_DOMAIN =
  "agenc.compaction-source.v1\0" as const;
export const COMPACTION_POLICY_DIGEST_DOMAIN =
  "agenc.compaction-policy.v1\0" as const;
export const COMPACTION_CONFIGURATION_DIGEST_DOMAIN =
  "agenc.compaction-configuration.v1\0" as const;
export const COMPACTION_ACCOUNTING_DIGEST_DOMAIN =
  "agenc.compaction-accounting.v1\0" as const;
export const COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN =
  "agenc.compaction-summary-dag.v1\0" as const;
export const COMPACTION_RETENTION_EXTENSION_DIGEST_DOMAIN =
  "agenc.compaction-retention-extension.v1\0" as const;
export const COMPACTION_PAYLOAD_DIGEST_DOMAIN =
  "agenc.compaction-payload.v1\0" as const;
export const COMPACTION_PAYLOAD_CHUNK_DIGEST_DOMAIN =
  "agenc.compaction-payload-chunk.v1\0" as const;
export const COMPACTION_PAYLOAD_MANIFEST_DIGEST_DOMAIN =
  "agenc.compaction-payload-manifest.v1\0" as const;

export const MAX_COMPACTION_PINS_PER_SESSION = 128;
export const MAX_COMPACTION_ACTIVE_PINS_GLOBAL = 4_096;
export const MAX_COMPACTION_PIN_HISTORY_TOTAL = 100_000;
export const MAX_COMPACTION_PINNED_BYTES_PER_SESSION = 1_073_741_824;
export const MAX_COMPACTION_PINNED_BYTES_GLOBAL = 8_589_934_592;
export const COMPACTION_ROLLBACK_RETENTION_MS = 604_800_000;
export const COMPACTION_RECONCILIATION_PAGE_SIZE = 256;
export const COMPACTION_PRUNE_RECORDS_PER_PAGE = 256;
export const MAX_COMPACTION_RECONCILIATION_PAGES_PER_START = 64;
export const MAX_COMPACTION_RECONCILIATION_MS_PER_START = 30_000;

export const MAX_COMPACTION_SOURCE_BYTES = 67_108_864;
export const MAX_COMPACTION_SOURCE_MESSAGES = 100_000;
export const MAX_COMPACTION_SEMANTIC_UNITS = 100_000;
export const MAX_COMPACTION_CHUNKS = 64;
export const MAX_COMPACTION_REDUCTION_LEVELS = 4;
export const MAX_COMPACTION_FAN_IN = 8;
export const MAX_COMPACTION_PROVIDER_CALLS = 73;
export const MAX_COMPACTION_TOTAL_INPUT_TOKENS = 4_000_000;
export const MAX_COMPACTION_INTERMEDIATE_TOKENS = 8_192;
export const MAX_COMPACTION_WALL_MS = 300_000;
export const MAX_COMPACTION_ABORT_QUIESCENCE_MS = 5_000;
export const MAX_COMPACTION_FOCUS_UTF8_BYTES = 16_384;
/** Canonical JSONL record ceiling shared with strict restart recovery. */
export const MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES = 4_194_304;
/** Worst-case nested JSON escaping of one accepted final provider response. */
export const MAX_COMPACTION_REPLACEMENT_SUMMARY_UTF8_BYTES = 8_388_608;
/** Fixed boundary/summary marker and canonical array framing reserve. */
export const MAX_COMPACTION_REPLACEMENT_ENVELOPE_UTF8_BYTES = 16_384;
export const COMPACTION_PAYLOAD_FORMAT_VERSION = 1 as const;
export const MAX_COMPACTION_PAYLOAD_CANONICAL_UTF8_BYTES = 134_217_728;
export const MAX_COMPACTION_PAYLOAD_CHUNKS = 256;

export const MAX_COMPACTION_OUTPUT_UTF8_BYTES_PER_CALL = 4_194_304;
export const MAX_COMPACTION_OUTPUT_UTF8_BYTES_TOTAL = 67_108_864;
export const MAX_COMPACTION_OUTPUT_DEPTH = 64;
export const MAX_COMPACTION_OUTPUT_NODES_PER_CALL = 20_000;
export const MAX_COMPACTION_OUTPUT_NODES_TOTAL = 200_000;
export const MAX_COMPACTION_PROVENANCE_REFERENCES_PER_OUTPUT = 1_024;
export const MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT = 1_000_000;

export const MAX_COMPACTION_NARRATIVE_UTF8_BYTES = 1_048_576;
export const MAX_COMPACTION_FACTS_PER_OUTPUT = 4_096;
export const MAX_COMPACTION_OPEN_ACTIONS_PER_OUTPUT = 4_096;
export const MAX_COMPACTION_TOOL_PAIRS_PER_OUTPUT = 4_096;
export const MAX_COMPACTION_RECORD_TEXT_UTF8_BYTES = 65_536;
export const MAX_COMPACTION_RECORD_ID_UTF8_BYTES = 1_024;
export const MAX_COMPACTION_SOURCE_REF_ID_UTF8_BYTES = 1_024;
export const MAX_COMPACTION_SOURCE_BINDING_UTF8_BYTES = 4_096;

export const MIN_COMPACTION_ABSOLUTE_TOKEN_SAVINGS = 1_024;
export const MIN_COMPACTION_RELATIVE_TOKEN_SAVINGS = 0.2;
export const MAX_COMPACTION_FAILURES_PER_HISTORY_DIGEST = 2;

export type CompactionStage = "map" | "reduce" | "final";

export interface RolloutSpanRefV1 {
  readonly kind: "rollout_span";
  readonly ref_id: string;
  readonly source_binding: string;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly sha256: string;
  /** Exact logical-history range represented by a persisted summary leaf. */
  readonly first_history_index?: number;
  readonly last_history_index?: number;
  /** Ordered active-history ref identities represented by the leaf. */
  readonly contributing_ref_ids?: readonly string[];
}

/** Exact canonical record and submessage that constitutes active history. */
export interface CompactionActiveHistoryRefV1 extends RolloutSpanRefV1 {
  readonly history_index: number;
  readonly record_message_index: number;
  readonly encoded_bytes: number;
}

/**
 * Compact persisted form. Attempt id, source binding, kind, history index,
 * and the single-record first/last sequence relation are carried once or
 * derived by array position during deterministic hydration.
 */
export interface CompactionActiveHistoryEntryV1 {
  readonly sequence: number;
  readonly record_message_index: number;
  readonly encoded_bytes: number;
  readonly sha256: string;
}

export type CompactionPayloadKind =
  | "active_history_refs"
  | "source_history"
  | "final_summary"
  | "summary_dag"
  | "replacement_history";

export interface CompactionPayloadManifestV1 {
  readonly version: typeof COMPACTION_PAYLOAD_FORMAT_VERSION;
  readonly attempt_id: string;
  readonly payload_kind: CompactionPayloadKind;
  readonly payload_sha256: string;
  readonly canonical_utf8_bytes: number;
  readonly item_count: number;
  readonly chunk_count: number;
  readonly final_chunk_sha256: string;
  readonly manifest_sha256: string;
}

export interface CompactionPayloadChunkV1 extends CompactionEventBaseV1 {
  readonly payload_kind: CompactionPayloadKind;
  readonly payload_sha256: string;
  readonly chunk_index: number;
  readonly chunk_count: number;
  readonly previous_chunk_sha256: string;
  readonly fragment_utf8_bytes: number;
  readonly canonical_json_fragment: string;
  readonly chunk_sha256: string;
}

export interface CompactionPayloadBundleV1 {
  readonly manifest: CompactionPayloadManifestV1;
  readonly chunks: readonly CompactionPayloadChunkV1[];
  readonly split_code_units_visited: number;
}

export interface CompactionSummaryRefV1 {
  readonly kind: "compaction_summary";
  readonly ref_id: string;
  readonly sha256: string;
}

export type CompactionSourceRefV1 =
  | RolloutSpanRefV1
  | CompactionSummaryRefV1;

export interface CompactionBodyRecordV1 {
  readonly id: string;
  readonly text: string;
  readonly source_ref_ids: readonly string[];
}

export interface CompactionToolPairV1 {
  readonly tool_call_id: string;
  readonly result_sha256: string;
}

export interface CompactionSummaryBodyV1 {
  readonly narrative: string;
  readonly facts: readonly CompactionBodyRecordV1[];
  readonly open_actions: readonly CompactionBodyRecordV1[];
  readonly tool_pairs: readonly CompactionToolPairV1[];
}

export interface CompactionSummaryV1 {
  readonly version: typeof COMPACTION_SUMMARY_VERSION;
  readonly kind: typeof COMPACTION_SUMMARY_KIND;
  readonly stage: CompactionStage;
  readonly attempt_id: string;
  readonly policy_digest: string;
  readonly accounting_ref: string;
  readonly source_refs: readonly CompactionSourceRefV1[];
  readonly body: CompactionSummaryBodyV1;
  readonly summary_sha256: string;
}

export type CompactionPinState =
  | "preparing"
  | "intent_bound"
  | "committed_reference"
  | "release_pending"
  | "released";

export interface CompactionSourceAuthorityV1 {
  readonly format_version: typeof COMPACTION_EVENT_FORMAT_VERSION;
  readonly attempt_id: string;
  readonly session_id: string;
  readonly epoch: number;
  readonly source_binding: string;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly source_sha256: string;
  readonly source_bytes: number;
  readonly history_digest: string;
  readonly active_history_refs: readonly CompactionActiveHistoryRefV1[];
}

/** Canonical single-record authority; the large ref vector is manifest-backed. */
export interface CompactionPersistedSourceAuthorityV1 extends Omit<
  CompactionSourceAuthorityV1,
  "active_history_refs"
> {
  readonly active_history_refs_manifest: CompactionPayloadManifestV1;
}

export interface CompactionPersistedIntentV1 extends CompactionEventBaseV1 {
  readonly source: CompactionPersistedSourceAuthorityV1;
  readonly source_history_manifest: CompactionPayloadManifestV1;
  readonly policy_digest: string;
  readonly configuration_digest: string;
  readonly accounting_ref: string;
  readonly automatic: boolean;
  readonly selected_history_indexes: readonly number[];
  readonly admission_required: true;
  readonly planned_provider_calls: number;
}

export interface CompactionAccountingObservationV1 {
  readonly accounting_ref: string;
  readonly source_tokens: number;
  readonly candidate_tokens: number;
  readonly context_window_tokens: number;
  readonly reserved_output_tokens: number;
  readonly source: string;
  readonly confidence: string;
}

export interface CompactionEventBaseV1 {
  readonly format_version: typeof COMPACTION_EVENT_FORMAT_VERSION;
  readonly minimum_reader_runtime: string;
  readonly attempt_id: string;
  readonly recorded_at_ms: number;
}

export interface CompactionIntentV1 extends CompactionEventBaseV1 {
  readonly source: CompactionSourceAuthorityV1;
  readonly policy_digest: string;
  readonly configuration_digest: string;
  readonly accounting_ref: string;
  readonly automatic: boolean;
  readonly selected_history_indexes: readonly number[];
  readonly admission_required: true;
  readonly planned_provider_calls: number;
}

export type CompactionFailureReason =
  | "aborted"
  | "provider_unavailable"
  | "provider_error"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_non_stop"
  | "provider_empty"
  | "output_invalid_json"
  | "output_schema_invalid"
  | "output_limit_exceeded"
  | "provenance_invalid"
  | "digest_invalid"
  | "injection_marker_leakage"
  | "source_limit_exceeded"
  | "semantic_unit_oversized"
  | "plan_limit_exceeded"
  | "token_budget_exceeded"
  | "no_shrink"
  | "pin_failed"
  | "intent_failed"
  | "commit_failed"
  | "wall_time_exceeded"
  | "recovery_interrupted";

export interface CompactionFailedV1 extends CompactionEventBaseV1 {
  readonly source_sha256: string;
  readonly history_digest: string;
  readonly reason: CompactionFailureReason;
  readonly detail_digest: string;
}

/** A strict, persisted model-history item used by compaction reconstruction. */
export interface CompactionProjectionMessageV1 {
  readonly role: "system" | "developer" | "user" | "assistant" | "tool";
  readonly content:
    | string
    | ReadonlyArray<{
        readonly type: string;
        readonly text?: string;
        readonly [key: string]: unknown;
      }>;
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly arguments?: string;
  }>;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly id?: string;
  readonly phase?: string;
  readonly endTurn?: boolean;
  readonly toolResultIntegrity?: ToolResultIntegrity;
  readonly agentInvocation?: AgentInvocationChannelMetadata;
  readonly compactionHistory?: CompactionHistoryMarkerV1;
}

export interface CompactionCommittedV1 extends CompactionEventBaseV1 {
  readonly committed_at_ms: number;
  readonly rollback_retention_deadline_ms: number;
  readonly source: CompactionSourceAuthorityV1;
  readonly selected_history_indexes: readonly number[];
  readonly policy_digest: string;
  readonly configuration_digest: string;
  readonly summary: CompactionSummaryV1;
  readonly summary_dag: CompactionSummaryDagV1;
  readonly accounting: CompactionAccountingObservationV1;
  readonly replacement_history: readonly CompactionProjectionMessageV1[];
  readonly cleanup_state: "pending" | "complete";
}

export interface CompactionPersistedCommittedV1 extends CompactionEventBaseV1 {
  readonly committed_at_ms: number;
  readonly rollback_retention_deadline_ms: number;
  readonly source: CompactionPersistedSourceAuthorityV1;
  readonly selected_history_indexes: readonly number[];
  readonly policy_digest: string;
  readonly configuration_digest: string;
  readonly final_summary_manifest: CompactionPayloadManifestV1;
  readonly summary_dag_manifest: CompactionPayloadManifestV1;
  readonly accounting: CompactionAccountingObservationV1;
  readonly replacement_history_manifest: CompactionPayloadManifestV1;
  readonly cleanup_state: "pending" | "complete";
}

export interface CompactionSummaryDagLeafV1 {
  readonly source_ref: RolloutSpanRefV1;
  readonly tool_pairs: readonly CompactionToolPairV1[];
}

export interface CompactionSummaryDagV1 {
  /** Effective fan-in selected by the frozen preflight plan. */
  readonly reduction_fan_in: number;
  /** Exact number of summary/provider-call levels, including map/final. */
  readonly maximum_levels: number;
  /** Exact number of provider calls represented by this persisted DAG. */
  readonly planned_provider_calls: number;
  readonly leaf_plan: readonly CompactionSummaryDagLeafV1[];
  readonly intermediate_summaries: ReadonlyArray<{
    readonly ref: CompactionSummaryRefV1;
    readonly summary: CompactionSummaryV1;
  }>;
  readonly dag_sha256: string;
}

export interface CompactionCleanupPendingV1 extends CompactionEventBaseV1 {
  readonly commit_sha256: string;
  readonly reason_digest: string;
}

export interface CompactionRollbackCommittedV1 extends CompactionEventBaseV1 {
  readonly commit_sha256: string;
  readonly source_sha256: string;
  readonly history_digest: string;
  readonly source_session_id: string;
  readonly source_epoch: number;
  readonly rollback_mode: "same_session" | "reviewed_branch";
  readonly target_session_id: string;
  readonly source_history: readonly CompactionProjectionMessageV1[];
}

export interface CompactionPersistedRollbackCommittedV1
  extends CompactionEventBaseV1 {
  readonly commit_sha256: string;
  readonly source_sha256: string;
  readonly history_digest: string;
  readonly source_session_id: string;
  readonly source_epoch: number;
  readonly rollback_mode: "same_session" | "reviewed_branch";
  readonly target_session_id: string;
  readonly source_history_manifest: CompactionPayloadManifestV1;
}

export interface CompactionSourceReleaseV1 extends CompactionEventBaseV1 {
  readonly source_sha256: string;
  readonly source_session_id: string;
  readonly source_epoch: number;
  readonly commit_sha256: string;
  readonly retention_deadline_ms: number;
  readonly reference_scan_generation: number;
}

/** Append-only operator extension of an already committed rollback window. */
export interface CompactionRetentionExtendedV1 extends CompactionEventBaseV1 {
  readonly commit_sha256: string;
  readonly source_sha256: string;
  readonly source_session_id: string;
  readonly source_epoch: number;
  readonly previous_retention_deadline_ms: number;
  readonly effective_retention_deadline_ms: number;
  readonly extension_sha256: string;
}

export interface CompactionPreparedSourceV1 {
  readonly source: CompactionSourceAuthorityV1;
  readonly messages: readonly RuntimeMessage[];
  readonly message_source_refs: readonly RolloutSpanRefV1[];
}

export interface CompactionCommitInputV1 {
  readonly intent: CompactionIntentV1;
  readonly summary: CompactionSummaryV1;
  readonly summary_dag: CompactionSummaryDagV1;
  readonly accounting: CompactionAccountingObservationV1;
  readonly replacement_history: readonly CompactionProjectionMessageV1[];
  readonly committed_at_ms: number;
  readonly payload_bundles: CompactionCommitPayloadBundlesV1;
}

export interface CompactionSourcePayloadBundlesV1 {
  readonly active_history_refs: CompactionPayloadBundleV1;
  readonly source_history: CompactionPayloadBundleV1;
}

export interface CompactionCommitPayloadBundlesV1 {
  readonly final_summary: CompactionPayloadBundleV1;
  readonly summary_dag: CompactionPayloadBundleV1;
  readonly replacement_history: CompactionPayloadBundleV1;
}

/** Exclusive durable-owner lease for one compaction transaction. */
export interface CompactionTransactionLease {
  release(): void | Promise<void>;
}

export interface CompactionTransactionAdapter {
  readonly sessionId: string;
  readonly epoch: number;
  acquireCompactionLease(
    attemptId: string,
  ): CompactionTransactionLease | Promise<CompactionTransactionLease>;
  prepareSource(
    attemptId: string,
    messages: readonly RuntimeMessage[],
  ): CompactionPreparedSourceV1;
  failureCount(historyDigest: string, configurationDigest: string): number;
  pinAndRecordIntent(
    intent: CompactionIntentV1,
    payloadBundles: CompactionSourcePayloadBundlesV1,
  ): void;
  recordFailure(failure: CompactionFailedV1): void;
  commit(input: CompactionCommitInputV1): CompactionCommittedV1;
  markProjectionComplete(attemptId: string): void;
  markProjectionFailed(attemptId: string, reason: unknown): never;
  markCleanupComplete(attemptId: string): void;
  markCleanupPending(attemptId: string, reason: unknown): void;
}

export interface CompactionTransactionMetadataV1 {
  readonly attempt_id: string;
  readonly history_digest: string;
  readonly configuration_digest: string;
  readonly committed: CompactionCommittedV1;
}

export class CompactionCannotReduceError extends Error {
  constructor(
    readonly code:
      | "failure_guard"
      | "no_shrink"
      | "source_limit"
      | "semantic_unit_oversized"
      | "plan_limit"
      | "context_limit",
    message: string,
  ) {
    super(message);
    this.name = "CompactionCannotReduceError";
  }
}

export class CompactionTransactionError extends Error {
  constructor(
    readonly reason: CompactionFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CompactionTransactionError";
  }
}

export class CompactionReconstructionRequiredError extends Error {
  constructor(readonly attemptId: string, options?: ErrorOptions) {
    super(
      `compaction ${attemptId} committed but projection failed; session reconstruction is required`,
      options,
    );
    this.name = "CompactionReconstructionRequiredError";
  }
}
