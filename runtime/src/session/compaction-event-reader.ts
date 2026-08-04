import {
  COMPACTION_EVENT_FORMAT_VERSION,
  COMPACTION_RETENTION_EXTENSION_DIGEST_DOMAIN,
  COMPACTION_ROLLBACK_RETENTION_MS,
  COMPACTION_SUMMARY_KIND,
  COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN,
  COMPACTION_SOURCE_DIGEST_DOMAIN,
  COMPACTION_SUMMARY_VERSION,
  MAX_COMPACTION_SOURCE_BYTES,
  MAX_COMPACTION_SOURCE_MESSAGES,
  MAX_COMPACTION_SOURCE_BINDING_UTF8_BYTES,
  MAX_COMPACTION_SOURCE_REF_ID_UTF8_BYTES,
  MAX_COMPACTION_PROVIDER_CALLS,
  MAX_COMPACTION_REDUCTION_LEVELS,
  MAX_COMPACTION_FAN_IN,
  MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES,
  COMPACTION_PAYLOAD_FORMAT_VERSION,
  MAX_COMPACTION_PAYLOAD_CANONICAL_UTF8_BYTES,
  MAX_COMPACTION_PAYLOAD_CHUNKS,
  MIN_COMPACTION_ABSOLUTE_TOKEN_SAVINGS,
  MIN_COMPACTION_RELATIVE_TOKEN_SAVINGS,
  type CompactionCleanupPendingV1,
  type CompactionCommittedV1,
  type CompactionFailedV1,
  type CompactionIntentV1,
  type CompactionPersistedIntentV1,
  type CompactionPersistedCommittedV1,
  type CompactionPersistedRollbackCommittedV1,
  type CompactionPersistedSourceAuthorityV1,
  type CompactionProjectionMessageV1,
  type CompactionPayloadChunkV1,
  type CompactionPayloadKind,
  type CompactionPayloadManifestV1,
  type CompactionRetentionExtendedV1,
  type CompactionRollbackCommittedV1,
  type CompactionSourceAuthorityV1,
  type CompactionSourceRefV1,
  type CompactionSourceReleaseV1,
  type CompactionSummaryV1,
  type CompactionSummaryDagV1,
  type CompactionToolPairV1,
} from "../services/compact/transaction-types.js";
import {
  verifyCompactionPayloadChunkV1,
  verifyCompactionPayloadManifestV1,
} from "../services/compact/payload-manifest.js";
import {
  digestWithDomain,
  validateProgrammaticCompactionBodyV1,
  validateCompactionProvenance,
  verifyCompactionSummaryDigest,
} from "../services/compact/summary-v1.js";
import { canonicalCompactionProjectionMessages } from "../services/compact/projection-digest.js";
import { verifyToolResultIntegrity } from "./tool-result-integrity.js";
import { assertAgentInvocationChannelMessage } from "../contracts/agent-invocation-envelope.js";
import {
  COMPACTION_HISTORY_MARKER_VERSION,
  type CompactionHistoryMarkerV1,
} from "./compaction-history-marker.js";
import { gte as semverGte } from "../utils/semver.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
/** First runtime capability that can safely read transactional C2 events. */
const COMPACTION_READER_RUNTIME_CAPABILITY = "0.14.0" as const;
const COMPACTION_EVENT_TYPES = Object.freeze([
  "compaction_intent",
  "compaction_payload_chunk",
  "compaction_failed",
  "compaction_committed",
  "compaction_cleanup_pending",
  "compaction_rollback_committed",
  "compaction_retention_extended",
  "compaction_source_release",
] as const);

export type CompactionRolloutType = (typeof COMPACTION_EVENT_TYPES)[number];

export type CompactionRolloutPayload =
  | CompactionIntentV1
  | CompactionPersistedIntentV1
  | CompactionPayloadChunkV1
  | CompactionFailedV1
  | CompactionCommittedV1
  | CompactionPersistedCommittedV1
  | CompactionCleanupPendingV1
  | CompactionRollbackCommittedV1
  | CompactionPersistedRollbackCommittedV1
  | CompactionRetentionExtendedV1
  | CompactionSourceReleaseV1;

export function isCompactionRolloutType(value: string): value is CompactionRolloutType {
  return (COMPACTION_EVENT_TYPES as readonly string[]).includes(value);
}

/** Strict, versioned reader. Recovery never guesses a newer event shape. */
export function readCompactionRolloutPayload(
  type: CompactionRolloutType,
  value: unknown,
): CompactionRolloutPayload {
  switch (type) {
    case "compaction_intent":
      return hasOwnField(value, "source_history_manifest")
        ? readCompactionPersistedIntentV1(value)
        : readIntent(value);
    case "compaction_payload_chunk":
      return readPayloadChunk(value);
    case "compaction_failed":
      return readFailure(value);
    case "compaction_committed":
      return hasOwnField(value, "final_summary_manifest")
        ? readCompactionPersistedCommittedV1(value)
        : readCommit(value);
    case "compaction_cleanup_pending":
      return readCleanupPending(value);
    case "compaction_rollback_committed":
      return hasOwnField(value, "source_history_manifest")
        ? readCompactionPersistedRollbackCommittedV1(value)
        : readRollback(value);
    case "compaction_retention_extended":
      return readRetentionExtension(value);
    case "compaction_source_release":
      return readRelease(value);
  }
}

function hasOwnField(value: unknown, field: string): boolean {
  return typeof value === "object" && value !== null &&
    Object.prototype.hasOwnProperty.call(value, field);
}

export function readCompactionPersistedIntentV1(
  value: unknown,
): CompactionPersistedIntentV1 {
  const record = exact(value, [
    ...baseKeys(),
    "source",
    "source_history_manifest",
    "policy_digest",
    "configuration_digest",
    "accounting_ref",
    "automatic",
    "selected_history_indexes",
    "admission_required",
    "planned_provider_calls",
  ]);
  const base = readBase(record);
  const source = readPersistedSource(record.source);
  const sourceHistoryManifest = readCompactionPayloadManifestV1(
    record.source_history_manifest,
    "source_history",
  );
  if (
    source.attempt_id !== base.attempt_id ||
    source.active_history_refs_manifest.attempt_id !== base.attempt_id ||
    sourceHistoryManifest.attempt_id !== base.attempt_id ||
    source.active_history_refs_manifest.item_count !==
      sourceHistoryManifest.item_count
  ) {
    throw malformed("manifest intent payloads do not bind one source attempt");
  }
  if (record.admission_required !== true) {
    throw malformed("transactional compaction requires durable admission");
  }
  return {
    ...base,
    source,
    source_history_manifest: sourceHistoryManifest,
    policy_digest: digest(record.policy_digest, "policy_digest"),
    configuration_digest: digest(record.configuration_digest, "configuration_digest"),
    accounting_ref: digest(record.accounting_ref, "accounting_ref"),
    automatic: boolean(record.automatic, "automatic"),
    selected_history_indexes: readManifestSelectedHistoryIndexes(
      record.selected_history_indexes,
      source.active_history_refs_manifest.item_count,
    ),
    admission_required: true,
    planned_provider_calls: integer(
      record.planned_provider_calls,
      "planned_provider_calls",
      1,
      MAX_COMPACTION_PROVIDER_CALLS,
    ),
  };
}

export function readCompactionPersistedCommittedV1(
  value: unknown,
): CompactionPersistedCommittedV1 {
  const record = exact(value, [
    ...baseKeys(),
    "committed_at_ms",
    "rollback_retention_deadline_ms",
    "source",
    "selected_history_indexes",
    "policy_digest",
    "configuration_digest",
    "final_summary_manifest",
    "summary_dag_manifest",
    "accounting",
    "replacement_history_manifest",
    "cleanup_state",
  ]);
  const base = readBase(record);
  const committedAtMs = integer(record.committed_at_ms, "committed_at_ms", 0);
  const source = readPersistedSource(record.source);
  const finalSummaryManifest = readCompactionPayloadManifestV1(
    record.final_summary_manifest,
    "final_summary",
  );
  const summaryDagManifest = readCompactionPayloadManifestV1(
    record.summary_dag_manifest,
    "summary_dag",
  );
  const replacementHistoryManifest = readCompactionPayloadManifestV1(
    record.replacement_history_manifest,
    "replacement_history",
  );
  if (
    committedAtMs !== base.recorded_at_ms ||
    source.attempt_id !== base.attempt_id ||
    [finalSummaryManifest, summaryDagManifest, replacementHistoryManifest]
      .some((manifest) => manifest.attempt_id !== base.attempt_id) ||
    finalSummaryManifest.item_count !== 1 ||
    summaryDagManifest.item_count !== 1 ||
    replacementHistoryManifest.item_count < 1
  ) {
    throw malformed("manifest commit payloads do not bind one source attempt");
  }
  const cleanupState = text(record.cleanup_state, "cleanup_state");
  if (cleanupState !== "pending" && cleanupState !== "complete") {
    throw malformed("cleanup_state is unsupported");
  }
  const accounting = readAccounting(record.accounting);
  assertCompactionShrink(accounting);
  return {
    ...base,
    committed_at_ms: committedAtMs,
    rollback_retention_deadline_ms: integer(
      record.rollback_retention_deadline_ms,
      "rollback_retention_deadline_ms",
      committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS,
    ),
    source,
    selected_history_indexes: readManifestSelectedHistoryIndexes(
      record.selected_history_indexes,
      source.active_history_refs_manifest.item_count,
    ),
    policy_digest: digest(record.policy_digest, "policy_digest"),
    configuration_digest: digest(record.configuration_digest, "configuration_digest"),
    final_summary_manifest: finalSummaryManifest,
    summary_dag_manifest: summaryDagManifest,
    accounting,
    replacement_history_manifest: replacementHistoryManifest,
    cleanup_state: cleanupState,
  };
}

export function readCompactionPersistedRollbackCommittedV1(
  value: unknown,
): CompactionPersistedRollbackCommittedV1 {
  const record = exact(value, [
    ...baseKeys(),
    "commit_sha256",
    "source_sha256",
    "history_digest",
    "source_session_id",
    "source_epoch",
    "rollback_mode",
    "target_session_id",
    "source_history_manifest",
  ]);
  const base = readBase(record);
  const mode = text(record.rollback_mode, "rollback_mode");
  if (mode !== "same_session" && mode !== "reviewed_branch") {
    throw malformed("rollback_mode is unsupported");
  }
  const sourceSessionId = text(record.source_session_id, "source_session_id");
  const targetSessionId = text(record.target_session_id, "target_session_id");
  if (
    mode === "same_session" && targetSessionId !== sourceSessionId ||
    mode === "reviewed_branch" && targetSessionId === sourceSessionId
  ) {
    throw malformed("rollback mode does not match its source and target sessions");
  }
  const sourceHistoryManifest = readCompactionPayloadManifestV1(
    record.source_history_manifest,
    "source_history",
  );
  if (sourceHistoryManifest.attempt_id !== base.attempt_id) {
    throw malformed("rollback source-history manifest attempt mismatch");
  }
  if (sourceHistoryManifest.item_count < 1) {
    throw malformed("rollback source-history manifest is empty");
  }
  return {
    ...base,
    commit_sha256: digest(record.commit_sha256, "commit_sha256"),
    source_sha256: digest(record.source_sha256, "source_sha256"),
    history_digest: digest(record.history_digest, "history_digest"),
    source_session_id: sourceSessionId,
    source_epoch: integer(record.source_epoch, "source_epoch", 1),
    rollback_mode: mode,
    target_session_id: targetSessionId,
    source_history_manifest: sourceHistoryManifest,
  };
}

function readPayloadChunk(value: unknown): CompactionPayloadChunkV1 {
  const record = exact(value, [
    ...baseKeys(),
    "payload_kind",
    "payload_sha256",
    "chunk_index",
    "chunk_count",
    "previous_chunk_sha256",
    "fragment_utf8_bytes",
    "canonical_json_fragment",
    "chunk_sha256",
  ]);
  const chunkCount = integer(
    record.chunk_count,
    "chunk_count",
    1,
    MAX_COMPACTION_PAYLOAD_CHUNKS,
  );
  const chunk: CompactionPayloadChunkV1 = {
    ...readBase(record),
    payload_kind: readPayloadKind(record.payload_kind),
    payload_sha256: digest(record.payload_sha256, "payload_sha256"),
    chunk_index: integer(record.chunk_index, "chunk_index", 0, chunkCount - 1),
    chunk_count: chunkCount,
    previous_chunk_sha256: digest(
      record.previous_chunk_sha256,
      "previous_chunk_sha256",
    ),
    fragment_utf8_bytes: integer(
      record.fragment_utf8_bytes,
      "fragment_utf8_bytes",
      0,
      MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES,
    ),
    canonical_json_fragment: boundedText(
      record.canonical_json_fragment,
      "canonical_json_fragment",
      MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES,
    ),
    chunk_sha256: digest(record.chunk_sha256, "chunk_sha256"),
  };
  if (
    chunk.chunk_index === 0 &&
    chunk.previous_chunk_sha256 !== "0".repeat(64)
  ) {
    throw malformed("first payload chunk has a predecessor");
  }
  verifyCompactionPayloadChunkV1(chunk);
  return chunk;
}

function readCompactionPayloadManifestV1(
  value: unknown,
  expectedKind?: CompactionPayloadKind,
): CompactionPayloadManifestV1 {
  const record = exact(value, [
    "version",
    "attempt_id",
    "payload_kind",
    "payload_sha256",
    "canonical_utf8_bytes",
    "item_count",
    "chunk_count",
    "final_chunk_sha256",
    "manifest_sha256",
  ]);
  if (record.version !== COMPACTION_PAYLOAD_FORMAT_VERSION) {
    throw malformed("unsupported compaction payload manifest version");
  }
  const payloadKind = readPayloadKind(record.payload_kind);
  if (expectedKind !== undefined && payloadKind !== expectedKind) {
    throw malformed("compaction payload manifest has the wrong kind");
  }
  const manifest: CompactionPayloadManifestV1 = {
    version: COMPACTION_PAYLOAD_FORMAT_VERSION,
    attempt_id: text(record.attempt_id, "attempt_id"),
    payload_kind: payloadKind,
    payload_sha256: digest(record.payload_sha256, "payload_sha256"),
    canonical_utf8_bytes: integer(
      record.canonical_utf8_bytes,
      "canonical_utf8_bytes",
      0,
      MAX_COMPACTION_PAYLOAD_CANONICAL_UTF8_BYTES,
    ),
    item_count: integer(
      record.item_count,
      "item_count",
      0,
      MAX_COMPACTION_SOURCE_MESSAGES + 8_192,
    ),
    chunk_count: integer(
      record.chunk_count,
      "chunk_count",
      1,
      MAX_COMPACTION_PAYLOAD_CHUNKS,
    ),
    final_chunk_sha256: digest(
      record.final_chunk_sha256,
      "final_chunk_sha256",
    ),
    manifest_sha256: digest(record.manifest_sha256, "manifest_sha256"),
  };
  verifyCompactionPayloadManifestV1(manifest);
  return manifest;
}

function readPayloadKind(value: unknown): CompactionPayloadKind {
  const kind = text(value, "payload_kind");
  if (
    kind !== "active_history_refs" &&
    kind !== "source_history" &&
    kind !== "final_summary" &&
    kind !== "summary_dag" &&
    kind !== "replacement_history"
  ) {
    throw malformed("unsupported compaction payload kind");
  }
  return kind;
}

function readIntent(value: unknown): CompactionIntentV1 {
  const record = exact(value, [
    ...baseKeys(),
    "source",
    "policy_digest",
    "configuration_digest",
    "accounting_ref",
    "automatic",
    "selected_history_indexes",
    "admission_required",
    "planned_provider_calls",
  ]);
  const base = readBase(record);
  const source = readSource(record.source);
  const selectedHistoryIndexes = readSelectedHistoryIndexes(
    record.selected_history_indexes,
    source,
  );
  if (record.admission_required !== true) {
    throw malformed("transactional compaction requires durable admission");
  }
  const plannedProviderCalls = integer(
    record.planned_provider_calls,
    "planned_provider_calls",
    1,
    MAX_COMPACTION_PROVIDER_CALLS,
  );
  if (source.attempt_id !== base.attempt_id) throw malformed("intent/source attempt mismatch");
  return {
    ...base,
    source,
    policy_digest: digest(record.policy_digest, "policy_digest"),
    configuration_digest: digest(record.configuration_digest, "configuration_digest"),
    accounting_ref: digest(record.accounting_ref, "accounting_ref"),
    automatic: boolean(record.automatic, "automatic"),
    selected_history_indexes: selectedHistoryIndexes,
    admission_required: true,
    planned_provider_calls: plannedProviderCalls,
  };
}

function readFailure(value: unknown): CompactionFailedV1 {
  const record = exact(value, [
    ...baseKeys(),
    "source_sha256",
    "history_digest",
    "reason",
    "detail_digest",
  ]);
  const reason = text(record.reason, "reason");
  const reasons = new Set([
    "aborted", "provider_unavailable", "provider_error",
    "provider_rate_limited", "provider_timeout", "provider_non_stop",
    "provider_empty", "output_invalid_json", "output_schema_invalid",
    "output_limit_exceeded", "provenance_invalid", "digest_invalid",
    "injection_marker_leakage", "source_limit_exceeded",
    "semantic_unit_oversized", "plan_limit_exceeded",
    "token_budget_exceeded", "no_shrink", "pin_failed", "intent_failed",
    "commit_failed", "wall_time_exceeded", "recovery_interrupted",
  ]);
  if (!reasons.has(reason)) throw malformed("unknown compaction failure reason");
  return {
    ...readBase(record),
    source_sha256: digest(record.source_sha256, "source_sha256"),
    history_digest: digest(record.history_digest, "history_digest"),
    reason: reason as CompactionFailedV1["reason"],
    detail_digest: digest(record.detail_digest, "detail_digest"),
  };
}

function readCommit(value: unknown): CompactionCommittedV1 {
  const record = exact(value, [
    ...baseKeys(),
    "committed_at_ms",
    "rollback_retention_deadline_ms",
    "source",
    "selected_history_indexes",
    "policy_digest",
    "configuration_digest",
    "summary",
    "summary_dag",
    "accounting",
    "replacement_history",
    "cleanup_state",
  ]);
  const base = readBase(record);
  const committedAt = integer(record.committed_at_ms, "committed_at_ms", 0);
  const deadline = integer(
    record.rollback_retention_deadline_ms,
    "rollback_retention_deadline_ms",
    committedAt + COMPACTION_ROLLBACK_RETENTION_MS,
  );
  const source = readSource(record.source);
  const selectedHistoryIndexes = readSelectedHistoryIndexes(
    record.selected_history_indexes,
    source,
  );
  const policyDigest = digest(record.policy_digest, "policy_digest");
  const configurationDigest = digest(
    record.configuration_digest,
    "configuration_digest",
  );
  const accounting = readAccounting(record.accounting);
  const summary = readSummary(record.summary);
  const summaryDag = readSummaryDag(
    record.summary_dag,
    summary,
    source,
    selectedHistoryIndexes,
  );
  if (
    committedAt !== base.recorded_at_ms ||
    source.attempt_id !== base.attempt_id ||
    summary.attempt_id !== base.attempt_id ||
    summary.policy_digest !== policyDigest ||
    summary.accounting_ref !== accounting.accounting_ref ||
    summary.stage !== "final"
  ) {
    throw malformed("committed summary does not bind its trusted wrapper fields");
  }
  assertCompactionShrink(accounting);
  if (!Array.isArray(record.replacement_history)) {
    throw malformed("replacement_history must be an array");
  }
  const replacementHistory = record.replacement_history.map((message) =>
    readProjectionMessage(message, source.session_id),
  );
  if (replacementHistory.length === 0) throw malformed("replacement_history is empty");
  assertCommitHistoryMarkers(
    replacementHistory,
    base.attempt_id,
    summary.summary_sha256,
  );
  const cleanupState = text(record.cleanup_state, "cleanup_state");
  if (cleanupState !== "pending" && cleanupState !== "complete") {
    throw malformed("cleanup_state is unsupported");
  }
  return {
    ...base,
    committed_at_ms: committedAt,
    rollback_retention_deadline_ms: deadline,
    source,
    selected_history_indexes: selectedHistoryIndexes,
    policy_digest: policyDigest,
    configuration_digest: configurationDigest,
    summary,
    summary_dag: summaryDag,
    accounting,
    replacement_history: replacementHistory,
    cleanup_state: cleanupState,
  };
}

function readSummaryDag(
  value: unknown,
  finalSummary: CompactionSummaryV1,
  source: CompactionSourceAuthorityV1,
  selectedHistoryIndexes: readonly number[],
): CompactionSummaryDagV1 {
  const record = exact(value, [
    "reduction_fan_in",
    "maximum_levels",
    "planned_provider_calls",
    "leaf_plan",
    "intermediate_summaries",
    "dag_sha256",
  ]);
  const reductionFanIn = integer(
    record.reduction_fan_in,
    "reduction_fan_in",
    2,
    MAX_COMPACTION_FAN_IN,
  );
  const maximumLevels = integer(
    record.maximum_levels,
    "maximum_levels",
    1,
    MAX_COMPACTION_REDUCTION_LEVELS,
  );
  const plannedProviderCalls = integer(
    record.planned_provider_calls,
    "planned_provider_calls",
    1,
    MAX_COMPACTION_PROVIDER_CALLS,
  );
  if (!Array.isArray(record.leaf_plan) || record.leaf_plan.length === 0) {
    throw malformed("summary DAG leaf plan must be nonempty");
  }
  if (
    !Array.isArray(record.intermediate_summaries) ||
    record.intermediate_summaries.length > MAX_COMPACTION_PROVIDER_CALLS - 1
  ) {
    throw malformed("summary DAG intermediates exceed their bound");
  }
  const leafPlan = record.leaf_plan.map((candidate) => {
    const leaf = exact(candidate, ["source_ref", "tool_pairs"]);
    const sourceRef = readSourceRef(leaf.source_ref);
    if (sourceRef.kind !== "rollout_span") {
      throw malformed("summary DAG leaf is not a rollout span");
    }
    if (!Array.isArray(leaf.tool_pairs)) {
      throw malformed("summary DAG leaf tool_pairs must be an array");
    }
    return {
      source_ref: sourceRef,
      tool_pairs: leaf.tool_pairs.map(readToolPair),
    };
  });
  assertSummaryLeavesBindSource(leafPlan, source, selectedHistoryIndexes);
  const intermediateIds = new Set<string>();
  const intermediateSummaries = record.intermediate_summaries.map((candidate) => {
    const entry = exact(candidate, ["ref", "summary"]);
    const ref = readSourceRef(entry.ref);
    if (ref.kind !== "compaction_summary") {
      throw malformed("summary DAG intermediate ref has the wrong kind");
    }
    if (intermediateIds.has(ref.ref_id)) {
      throw malformed("summary DAG repeats an intermediate ref_id");
    }
    intermediateIds.add(ref.ref_id);
    const summary = readSummary(entry.summary);
    if (ref.sha256 !== summary.summary_sha256) {
      throw malformed("summary DAG intermediate digest mismatch");
    }
    if (
      summary.stage === "final" ||
      summary.attempt_id !== finalSummary.attempt_id ||
      summary.policy_digest !== finalSummary.policy_digest ||
      summary.accounting_ref !== finalSummary.accounting_ref
    ) {
      throw malformed("summary DAG intermediate does not bind the final wrapper");
    }
    return { ref, summary };
  });
  const withoutDigest = {
    reduction_fan_in: reductionFanIn,
    maximum_levels: maximumLevels,
    planned_provider_calls: plannedProviderCalls,
    leaf_plan: leafPlan,
    intermediate_summaries: intermediateSummaries,
  };
  const dagSha256 = digest(record.dag_sha256, "dag_sha256");
  if (
    dagSha256 !==
    digestWithDomain(COMPACTION_SUMMARY_DAG_DIGEST_DOMAIN, withoutDigest)
  ) {
    throw malformed("summary DAG digest mismatch");
  }
  const summaries = new Map(
    intermediateSummaries.map((entry) => [entry.ref.ref_id, entry.summary]),
  );
  validateCompactionProvenance({
    final: finalSummary,
    summariesById: summaries,
    plannedLeaves: leafPlan.map((leaf) => leaf.source_ref),
  });
  assertSummaryDagTopology({
    finalSummary,
    summaries,
    plannedProviderCalls,
    reductionFanIn,
    maximumLevels,
  });
  const reachableIntermediateIds = reachableCompactionSummaryIds(
    finalSummary,
    summaries,
  );
  if (
    reachableIntermediateIds.size !== summaries.size ||
    [...summaries.keys()].some((id) => !reachableIntermediateIds.has(id))
  ) {
    throw malformed("summary DAG contains an unreachable intermediate");
  }
  const expectedPairs = leafPlan.flatMap((leaf) => leaf.tool_pairs);
  if (
    finalSummary.body.tool_pairs.length !== expectedPairs.length ||
    finalSummary.body.tool_pairs.some(
      (pair, index) =>
        pair.tool_call_id !== expectedPairs[index]?.tool_call_id ||
        pair.result_sha256 !== expectedPairs[index]?.result_sha256,
    )
  ) {
    throw malformed("summary DAG does not preserve exact tool pairs");
  }
  return {
    ...withoutDigest,
    dag_sha256: dagSha256,
  };
}

function assertSummaryDagTopology(params: {
  readonly finalSummary: CompactionSummaryV1;
  readonly summaries: ReadonlyMap<string, CompactionSummaryV1>;
  readonly plannedProviderCalls: number;
  readonly reductionFanIn: number;
  readonly maximumLevels: number;
}): void {
  if (params.summaries.size + 1 !== params.plannedProviderCalls) {
    throw malformed("summary DAG provider-call count does not match its frozen plan");
  }

  const depths = new Map<string, number>();
  const active = new Set<string>();
  const depthOf = (summary: CompactionSummaryV1, id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (active.has(id)) throw malformed("summary DAG contains a cycle");
    active.add(id);
    const rolloutChildren = summary.source_refs.filter(
      (ref) => ref.kind === "rollout_span",
    );
    const summaryChildren = summary.source_refs.filter(
      (ref) => ref.kind === "compaction_summary",
    );
    if (summary.source_refs.length > params.reductionFanIn) {
      throw malformed("summary DAG node exceeds its frozen fan-in");
    }
    if (summary.stage === "map") {
      if (rolloutChildren.length !== 1 || summaryChildren.length !== 0) {
        throw malformed("summary DAG map node has invalid children");
      }
    } else if (summaryChildren.length === 0) {
      if (
        summary.stage !== "final" ||
        rolloutChildren.length !== 1 ||
        params.plannedProviderCalls !== 1
      ) {
        throw malformed("summary DAG reduction node has invalid leaf children");
      }
    } else if (
      rolloutChildren.length !== 0 ||
      summaryChildren.length < 2
    ) {
      throw malformed("summary DAG reduction node has invalid children");
    }
    const childDepth = summaryChildren.reduce((maximum, ref) => {
      const child = params.summaries.get(ref.ref_id);
      if (child === undefined) {
        throw malformed("summary DAG references an unknown child");
      }
      return Math.max(maximum, depthOf(child, ref.ref_id));
    }, 0);
    active.delete(id);
    const depth = childDepth + 1;
    if (depth > MAX_COMPACTION_REDUCTION_LEVELS) {
      throw malformed("summary DAG exceeds its maximum depth");
    }
    depths.set(id, depth);
    return depth;
  };

  const actualLevels = depthOf(params.finalSummary, "<final>");
  if (actualLevels !== params.maximumLevels) {
    throw malformed("summary DAG depth does not match its frozen plan");
  }
}

function reachableCompactionSummaryIds(
  finalSummary: CompactionSummaryV1,
  summaries: ReadonlyMap<string, CompactionSummaryV1>,
): ReadonlySet<string> {
  const reachable = new Set<string>();
  const pending = finalSummary.source_refs
    .filter((ref) => ref.kind === "compaction_summary")
    .map((ref) => ref.ref_id);
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    const summary = summaries.get(id);
    if (summary === undefined) continue;
    reachable.add(id);
    for (const ref of summary.source_refs) {
      if (ref.kind === "compaction_summary") pending.push(ref.ref_id);
    }
  }
  return reachable;
}

function assertSummaryLeavesBindSource(
  leafPlan: CompactionSummaryDagV1["leaf_plan"],
  source: CompactionSourceAuthorityV1,
  selectedHistoryIndexes: readonly number[],
): void {
  const seenIds = new Set<string>();
  const coveredHistoryIndexes = new Set<number>();
  const selectedHistoryRefs = selectedHistoryIndexes.map(
    (index) => source.active_history_refs[index]!,
  );
  let selectedCursor = 0;
  let previousLastHistoryIndex = -1;
  for (const leaf of leafPlan) {
    const ref = leaf.source_ref;
    const contributingIds = ref.contributing_ref_ids;
    if (
      seenIds.has(ref.ref_id) ||
      ref.source_binding !== source.source_binding ||
      ref.first_sequence < source.first_sequence ||
      ref.last_sequence > source.last_sequence ||
      ref.first_history_index === undefined ||
      ref.last_history_index === undefined ||
      ref.first_history_index <= previousLastHistoryIndex ||
      ref.last_history_index < ref.first_history_index ||
      contributingIds === undefined ||
      contributingIds.length === 0
    ) {
      throw malformed("summary DAG leaf is foreign, overlapping, or out of order");
    }
    seenIds.add(ref.ref_id);
    const contributing = selectedHistoryRefs.slice(
      selectedCursor,
      selectedCursor + contributingIds.length,
    );
    if (
      contributing.length !== contributingIds.length ||
      contributing.some((active, index) => active.ref_id !== contributingIds[index]) ||
      contributing[0]!.history_index !== ref.first_history_index ||
      contributing.at(-1)!.history_index !== ref.last_history_index ||
      contributing[0]!.first_sequence !== ref.first_sequence ||
      contributing.at(-1)!.last_sequence !== ref.last_sequence
    ) {
      throw malformed("summary DAG leaf does not exactly cover authoritative history");
    }
    for (const active of contributing) {
      if (coveredHistoryIndexes.has(active.history_index)) {
        throw malformed("summary DAG covers authoritative history more than once");
      }
      coveredHistoryIndexes.add(active.history_index);
    }
    const messageSources = contributing.map((active) => ({
      kind: active.kind,
      ref_id: active.ref_id,
      source_binding: active.source_binding,
      first_sequence: active.first_sequence,
      last_sequence: active.last_sequence,
      sha256: active.sha256,
      first_history_index: active.history_index,
      last_history_index: active.history_index,
      contributing_ref_ids: [active.ref_id],
    }));
    const expectedSha256 = digestWithDomain(COMPACTION_SOURCE_DIGEST_DOMAIN, {
      source_sha256: source.source_sha256,
      message_sources: messageSources,
    });
    if (ref.sha256 !== expectedSha256) {
      throw malformed("summary DAG leaf digest does not match authoritative history");
    }
    selectedCursor += contributing.length;
    previousLastHistoryIndex = ref.last_history_index;
  }
  if (
    selectedCursor !== selectedHistoryRefs.length ||
    coveredHistoryIndexes.size !== selectedHistoryRefs.length
  ) {
    throw malformed("summary DAG leaves do not completely cover authoritative history");
  }
}

function readSelectedHistoryIndexes(
  value: unknown,
  source: CompactionSourceAuthorityV1,
): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_COMPACTION_SOURCE_MESSAGES
  ) {
    throw malformed("selected history manifest is empty or exceeds its limit");
  }
  let previous = -1;
  return value.map((candidate) => {
    const index = integer(
      candidate,
      "selected_history_indexes entry",
      0,
      source.active_history_refs.length - 1,
    );
    if (index <= previous) {
      throw malformed("selected history manifest is not strictly ordered");
    }
    previous = index;
    return index;
  });
}

function readManifestSelectedHistoryIndexes(
  value: unknown,
  activeHistoryCount: number,
): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > activeHistoryCount
  ) {
    throw malformed("selected history manifest is empty or exceeds its source");
  }
  let previous = -1;
  return value.map((candidate) => {
    const index = integer(
      candidate,
      "selected_history_indexes entry",
      0,
      activeHistoryCount - 1,
    );
    if (index <= previous) {
      throw malformed("selected history manifest is not strictly ordered");
    }
    previous = index;
    return index;
  });
}

function assertCompactionShrink(
  accounting: CompactionCommittedV1["accounting"],
): void {
  const savings = accounting.source_tokens - accounting.candidate_tokens;
  const relativeSavings = accounting.source_tokens === 0
    ? 0
    : savings / accounting.source_tokens;
  if (
    accounting.candidate_tokens + accounting.reserved_output_tokens >
      accounting.context_window_tokens ||
    savings < MIN_COMPACTION_ABSOLUTE_TOKEN_SAVINGS ||
    relativeSavings < MIN_COMPACTION_RELATIVE_TOKEN_SAVINGS
  ) {
    throw malformed("committed accounting does not prove a bounded shrink");
  }
}

function readToolPair(value: unknown): CompactionToolPairV1 {
  const pair = exact(value, ["tool_call_id", "result_sha256"]);
  return {
    tool_call_id: text(pair.tool_call_id, "tool_call_id"),
    result_sha256: digest(pair.result_sha256, "result_sha256"),
  };
}

function readCleanupPending(value: unknown): CompactionCleanupPendingV1 {
  const record = exact(value, [...baseKeys(), "commit_sha256", "reason_digest"]);
  return {
    ...readBase(record),
    commit_sha256: digest(record.commit_sha256, "commit_sha256"),
    reason_digest: digest(record.reason_digest, "reason_digest"),
  };
}

function readRollback(value: unknown): CompactionRollbackCommittedV1 {
  const record = exact(value, [
    ...baseKeys(),
    "commit_sha256",
    "source_sha256",
    "history_digest",
    "source_session_id",
    "source_epoch",
    "rollback_mode",
    "target_session_id",
    "source_history",
  ]);
  const mode = text(record.rollback_mode, "rollback_mode");
  if (mode !== "same_session" && mode !== "reviewed_branch") {
    throw malformed("rollback_mode is unsupported");
  }
  const sourceSessionId = text(record.source_session_id, "source_session_id");
  const targetSessionId = text(record.target_session_id, "target_session_id");
  if (
    (mode === "same_session" && targetSessionId !== sourceSessionId) ||
    (mode === "reviewed_branch" && targetSessionId === sourceSessionId)
  ) {
    throw malformed("rollback mode does not match its source and target sessions");
  }
  if (!Array.isArray(record.source_history)) throw malformed("source_history must be an array");
  const sourceHistory = record.source_history.map((message) =>
    readProjectionMessage(message, sourceSessionId),
  );
  const historyDigest = digest(record.history_digest, "history_digest");
  if (
    digestWithDomain(
      COMPACTION_SOURCE_DIGEST_DOMAIN,
      canonicalCompactionProjectionMessages(sourceHistory),
    ) !== historyDigest
  ) {
    throw malformed("rollback source_history does not match history_digest");
  }
  return {
    ...readBase(record),
    commit_sha256: digest(record.commit_sha256, "commit_sha256"),
    source_sha256: digest(record.source_sha256, "source_sha256"),
    history_digest: historyDigest,
    source_session_id: sourceSessionId,
    source_epoch: integer(record.source_epoch, "source_epoch", 1),
    rollback_mode: mode,
    target_session_id: targetSessionId,
    source_history: sourceHistory,
  };
}

function readRelease(value: unknown): CompactionSourceReleaseV1 {
  const record = exact(value, [
    ...baseKeys(),
    "source_sha256",
    "source_session_id",
    "source_epoch",
    "commit_sha256",
    "retention_deadline_ms",
    "reference_scan_generation",
  ]);
  return {
    ...readBase(record),
    source_sha256: digest(record.source_sha256, "source_sha256"),
    source_session_id: text(record.source_session_id, "source_session_id"),
    source_epoch: integer(record.source_epoch, "source_epoch", 1),
    commit_sha256: digest(record.commit_sha256, "commit_sha256"),
    retention_deadline_ms: integer(record.retention_deadline_ms, "retention_deadline_ms", 0),
    reference_scan_generation: integer(
      record.reference_scan_generation,
      "reference_scan_generation",
      1,
    ),
  };
}

function readRetentionExtension(value: unknown): CompactionRetentionExtendedV1 {
  const record = exact(value, [
    ...baseKeys(),
    "commit_sha256",
    "source_sha256",
    "source_session_id",
    "source_epoch",
    "previous_retention_deadline_ms",
    "effective_retention_deadline_ms",
    "extension_sha256",
  ]);
  const withoutDigest = {
    ...readBase(record),
    commit_sha256: digest(record.commit_sha256, "commit_sha256"),
    source_sha256: digest(record.source_sha256, "source_sha256"),
    source_session_id: text(record.source_session_id, "source_session_id"),
    source_epoch: integer(record.source_epoch, "source_epoch", 1),
    previous_retention_deadline_ms: integer(
      record.previous_retention_deadline_ms,
      "previous_retention_deadline_ms",
      0,
    ),
    effective_retention_deadline_ms: integer(
      record.effective_retention_deadline_ms,
      "effective_retention_deadline_ms",
      1,
    ),
  };
  if (
    withoutDigest.effective_retention_deadline_ms <=
      withoutDigest.previous_retention_deadline_ms
  ) {
    throw malformed("retention extension must strictly increase its deadline");
  }
  const extensionSha256 = digest(record.extension_sha256, "extension_sha256");
  if (
    extensionSha256 !==
    digestWithDomain(COMPACTION_RETENTION_EXTENSION_DIGEST_DOMAIN, withoutDigest)
  ) {
    throw malformed("retention extension digest mismatch");
  }
  return { ...withoutDigest, extension_sha256: extensionSha256 };
}

function readSummary(value: unknown): CompactionSummaryV1 {
  const record = exact(value, [
    "version", "kind", "stage", "attempt_id", "policy_digest",
    "accounting_ref", "source_refs", "body", "summary_sha256",
  ]);
  if (record.version !== COMPACTION_SUMMARY_VERSION || record.kind !== COMPACTION_SUMMARY_KIND) {
    throw malformed("unsupported compaction summary version or kind");
  }
  const stage = text(record.stage, "stage");
  if (stage !== "map" && stage !== "reduce" && stage !== "final") {
    throw malformed("unsupported compaction summary stage");
  }
  if (!Array.isArray(record.source_refs) || record.source_refs.length === 0) {
    throw malformed("summary source_refs must be nonempty");
  }
  const sourceRefs = record.source_refs.map(readSourceRef);
  const allowedIds = new Set(sourceRefs.map((ref) => ref.ref_id));
  const body = validateProgrammaticCompactionBodyV1(record.body, allowedIds).body;
  const summary: CompactionSummaryV1 = {
    version: COMPACTION_SUMMARY_VERSION,
    kind: COMPACTION_SUMMARY_KIND,
    stage,
    attempt_id: text(record.attempt_id, "attempt_id"),
    policy_digest: digest(record.policy_digest, "policy_digest"),
    accounting_ref: digest(record.accounting_ref, "accounting_ref"),
    source_refs: sourceRefs,
    body,
    summary_sha256: digest(record.summary_sha256, "summary_sha256"),
  };
  verifyCompactionSummaryDigest(summary);
  return summary;
}

function readSourceRef(value: unknown): CompactionSourceRefV1 {
  const record = plainRecord(value, "source ref");
  if (record.kind === "rollout_span") {
    exact(record, [
      "kind", "ref_id", "source_binding", "first_sequence",
      "last_sequence", "sha256", "first_history_index",
      "last_history_index", "contributing_ref_ids",
    ]);
    const firstHistoryIndex = integer(
      record.first_history_index,
      "first_history_index",
      0,
      MAX_COMPACTION_SOURCE_MESSAGES - 1,
    );
    const lastHistoryIndex = integer(
      record.last_history_index,
      "last_history_index",
      firstHistoryIndex,
      MAX_COMPACTION_SOURCE_MESSAGES - 1,
    );
    if (
      !Array.isArray(record.contributing_ref_ids) ||
      record.contributing_ref_ids.length === 0 ||
      record.contributing_ref_ids.length > MAX_COMPACTION_SOURCE_MESSAGES
    ) {
      throw malformed("rollout span contributing_ref_ids is invalid");
    }
    const contributingRefIds = record.contributing_ref_ids.map((candidate) =>
      boundedText(
        candidate,
        "contributing_ref_ids entry",
        MAX_COMPACTION_SOURCE_REF_ID_UTF8_BYTES,
      )
    );
    if (new Set(contributingRefIds).size !== contributingRefIds.length) {
      throw malformed("rollout span contributing_ref_ids contains duplicates");
    }
    return {
      kind: "rollout_span",
      ref_id: boundedText(
        record.ref_id,
        "ref_id",
        MAX_COMPACTION_SOURCE_REF_ID_UTF8_BYTES,
      ),
      source_binding: boundedText(
        record.source_binding,
        "source_binding",
        MAX_COMPACTION_SOURCE_BINDING_UTF8_BYTES,
      ),
      first_sequence: integer(record.first_sequence, "first_sequence", 1),
      last_sequence: integer(record.last_sequence, "last_sequence", 1),
      sha256: digest(record.sha256, "sha256"),
      first_history_index: firstHistoryIndex,
      last_history_index: lastHistoryIndex,
      contributing_ref_ids: contributingRefIds,
    };
  }
  if (record.kind === "compaction_summary") {
    exact(record, ["kind", "ref_id", "sha256"]);
    return {
      kind: "compaction_summary",
      ref_id: boundedText(
        record.ref_id,
        "ref_id",
        MAX_COMPACTION_SOURCE_REF_ID_UTF8_BYTES,
      ),
      sha256: digest(record.sha256, "sha256"),
    };
  }
  throw malformed("unknown compaction source-ref kind");
}

function readSource(value: unknown): CompactionSourceAuthorityV1 {
  const record = exact(value, [
    "format_version", "attempt_id", "session_id", "epoch", "source_binding",
    "first_sequence", "last_sequence", "source_sha256", "source_bytes",
    "history_digest", "active_history_refs",
  ]);
  if (record.format_version !== COMPACTION_EVENT_FORMAT_VERSION) {
    throw malformed("unsupported compaction source version");
  }
  const first = integer(record.first_sequence, "first_sequence", 1);
  const last = integer(record.last_sequence, "last_sequence", first);
  if (
    !Array.isArray(record.active_history_refs) ||
    record.active_history_refs.length === 0 ||
    record.active_history_refs.length > MAX_COMPACTION_SOURCE_MESSAGES
  ) {
    throw malformed("active_history_refs is empty or exceeds its limit");
  }
  const activeHistoryRefs = record.active_history_refs.map((candidate, index) => {
    const ref = exact(candidate, [
      "kind", "ref_id", "source_binding", "first_sequence", "last_sequence",
      "sha256", "history_index", "record_message_index", "encoded_bytes",
    ]);
    if (ref.kind !== "rollout_span") throw malformed("active history ref kind is invalid");
    const refFirst = integer(ref.first_sequence, "first_sequence", 1);
    const refLast = integer(ref.last_sequence, "last_sequence", refFirst);
    const historyIndex = integer(ref.history_index, "history_index", 0);
    if (historyIndex !== index) throw malformed("active history refs are out of order");
    return {
      kind: "rollout_span" as const,
      ref_id: boundedText(
        ref.ref_id,
        "ref_id",
        MAX_COMPACTION_SOURCE_REF_ID_UTF8_BYTES,
      ),
      source_binding: boundedText(
        ref.source_binding,
        "source_binding",
        MAX_COMPACTION_SOURCE_BINDING_UTF8_BYTES,
      ),
      first_sequence: refFirst,
      last_sequence: refLast,
      sha256: digest(ref.sha256, "sha256"),
      history_index: historyIndex,
      record_message_index: integer(
        ref.record_message_index,
        "record_message_index",
        0,
        MAX_COMPACTION_SOURCE_MESSAGES - 1,
      ),
      encoded_bytes: integer(ref.encoded_bytes, "encoded_bytes", 1),
    };
  });
  const sourceBinding = boundedText(
    record.source_binding,
    "source_binding",
    MAX_COMPACTION_SOURCE_BINDING_UTF8_BYTES,
  );
  const uniqueRecordBytes = new Map<number, number>();
  for (const ref of activeHistoryRefs) {
    if (
      ref.source_binding !== sourceBinding ||
      ref.first_sequence !== ref.last_sequence ||
      ref.first_sequence < first ||
      ref.last_sequence > last
    ) {
      throw malformed("active history ref falls outside its source authority");
    }
    const existingBytes = uniqueRecordBytes.get(ref.first_sequence);
    if (existingBytes !== undefined && existingBytes !== ref.encoded_bytes) {
      throw malformed("active history refs disagree on physical record length");
    }
    uniqueRecordBytes.set(ref.first_sequence, ref.encoded_bytes);
  }
  if (
    Math.min(...activeHistoryRefs.map((ref) => ref.first_sequence)) !== first ||
    Math.max(...activeHistoryRefs.map((ref) => ref.last_sequence)) !== last
  ) {
    throw malformed("source sequence bounds do not match active history refs");
  }
  const sourceBytes = integer(
    record.source_bytes,
    "source_bytes",
    1,
    MAX_COMPACTION_SOURCE_BYTES,
  );
  if ([...uniqueRecordBytes.values()].reduce((sum, value) => sum + value, 0) !== sourceBytes) {
    throw malformed("source_bytes does not match the active physical record manifest");
  }
  return {
    format_version: COMPACTION_EVENT_FORMAT_VERSION,
    attempt_id: text(record.attempt_id, "attempt_id"),
    session_id: text(record.session_id, "session_id"),
    epoch: integer(record.epoch, "epoch", 1),
    source_binding: sourceBinding,
    first_sequence: first,
    last_sequence: last,
    source_sha256: digest(record.source_sha256, "source_sha256"),
    source_bytes: sourceBytes,
    history_digest: digest(record.history_digest, "history_digest"),
    active_history_refs: activeHistoryRefs,
  };
}

function readPersistedSource(
  value: unknown,
): CompactionPersistedSourceAuthorityV1 {
  const record = exact(value, [
    "format_version",
    "attempt_id",
    "session_id",
    "epoch",
    "source_binding",
    "first_sequence",
    "last_sequence",
    "source_sha256",
    "source_bytes",
    "history_digest",
    "active_history_refs_manifest",
  ]);
  if (record.format_version !== COMPACTION_EVENT_FORMAT_VERSION) {
    throw malformed("unsupported compaction source version");
  }
  const attemptId = text(record.attempt_id, "attempt_id");
  const activeHistoryRefsManifest = readCompactionPayloadManifestV1(
    record.active_history_refs_manifest,
    "active_history_refs",
  );
  if (
    activeHistoryRefsManifest.attempt_id !== attemptId ||
    activeHistoryRefsManifest.item_count < 1 ||
    activeHistoryRefsManifest.item_count > MAX_COMPACTION_SOURCE_MESSAGES
  ) {
    throw malformed("active-history manifest does not bind its source attempt");
  }
  const firstSequence = integer(record.first_sequence, "first_sequence", 1);
  return {
    format_version: COMPACTION_EVENT_FORMAT_VERSION,
    attempt_id: attemptId,
    session_id: text(record.session_id, "session_id"),
    epoch: integer(record.epoch, "epoch", 1),
    source_binding: boundedText(
      record.source_binding,
      "source_binding",
      MAX_COMPACTION_SOURCE_BINDING_UTF8_BYTES,
    ),
    first_sequence: firstSequence,
    last_sequence: integer(
      record.last_sequence,
      "last_sequence",
      firstSequence,
    ),
    source_sha256: digest(record.source_sha256, "source_sha256"),
    source_bytes: integer(
      record.source_bytes,
      "source_bytes",
      1,
      MAX_COMPACTION_SOURCE_BYTES,
    ),
    history_digest: digest(record.history_digest, "history_digest"),
    active_history_refs_manifest: activeHistoryRefsManifest,
  };
}

function readAccounting(value: unknown): CompactionCommittedV1["accounting"] {
  const record = exact(value, [
    "accounting_ref", "source_tokens", "candidate_tokens",
    "context_window_tokens", "reserved_output_tokens", "source", "confidence",
  ]);
  return {
    accounting_ref: digest(record.accounting_ref, "accounting_ref"),
    source_tokens: integer(record.source_tokens, "source_tokens", 0),
    candidate_tokens: integer(record.candidate_tokens, "candidate_tokens", 0),
    context_window_tokens: integer(record.context_window_tokens, "context_window_tokens", 1),
    reserved_output_tokens: integer(record.reserved_output_tokens, "reserved_output_tokens", 0),
    source: text(record.source, "source"),
    confidence: text(record.confidence, "confidence"),
  };
}

function readProjectionMessage(
  value: unknown,
  expectedRunId?: string,
): CompactionProjectionMessageV1 {
  const record = exactOptional(
    value,
    ["role", "content"],
    [
      "toolCalls", "toolCallId", "toolName", "id", "phase", "endTurn",
      "toolResultIntegrity", "agentInvocation",
      "compactionHistory",
    ],
    "replacement-history message",
  );
  const role = text(record.role, "role");
  if (!["system", "developer", "user", "assistant", "tool"].includes(role)) {
    throw malformed("replacement-history role is unsupported");
  }
  const content = readProjectionContent(record.content);
  const toolCalls = record.toolCalls === undefined
    ? undefined
    : readProjectionToolCalls(record.toolCalls);
  const toolCallId = record.toolCallId === undefined
    ? undefined
    : text(record.toolCallId, "toolCallId");
  const toolName = record.toolName === undefined
    ? undefined
    : text(record.toolName, "toolName");
  const id = record.id === undefined ? undefined : text(record.id, "id");
  const phase = record.phase === undefined ? undefined : text(record.phase, "phase");
  if (phase !== undefined && phase !== "commentary" && phase !== "final_answer") {
    throw malformed("replacement-history phase is unsupported");
  }
  if (record.endTurn !== undefined && typeof record.endTurn !== "boolean") {
    throw malformed("replacement-history endTurn must be boolean");
  }
  if (record.toolResultIntegrity !== undefined) {
    if (toolCallId === undefined) {
      throw malformed("tool-result integrity requires toolCallId");
    }
    const verification = verifyToolResultIntegrity({
      integrity: record.toolResultIntegrity,
      ...(expectedRunId !== undefined ? { expectedRunId } : {}),
      toolCallId,
      content,
    });
    if (verification.status !== "valid") {
      throw malformed(`replacement-history tool integrity is ${verification.status}`);
    }
  }
  const result: CompactionProjectionMessageV1 = {
    role: role as CompactionProjectionMessageV1["role"],
    content,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(record.endTurn !== undefined ? { endTurn: record.endTurn } : {}),
    ...(record.toolResultIntegrity !== undefined
      ? { toolResultIntegrity: record.toolResultIntegrity as CompactionProjectionMessageV1["toolResultIntegrity"] }
      : {}),
    ...(record.agentInvocation !== undefined
      ? { agentInvocation: record.agentInvocation as CompactionProjectionMessageV1["agentInvocation"] }
      : {}),
    ...(record.compactionHistory !== undefined
      ? { compactionHistory: readCompactionHistoryMarker(record.compactionHistory) }
      : {}),
  };
  if (result.agentInvocation !== undefined) {
    try {
      assertAgentInvocationChannelMessage({
        role: result.role,
        content: result.content,
        runtimeOnly: { agentInvocation: result.agentInvocation },
      });
    } catch {
      throw malformed("replacement-history agent invocation is invalid");
    }
  }
  return result;
}

function readCompactionHistoryMarker(value: unknown): CompactionHistoryMarkerV1 {
  const record = exact(value, [
    "version",
    "kind",
    "attempt_id",
    "summary_sha256",
  ]);
  if (record.version !== COMPACTION_HISTORY_MARKER_VERSION) {
    throw malformed("unsupported compaction-history marker version");
  }
  const kind = text(record.kind, "compaction-history kind");
  if (kind !== "boundary" && kind !== "summary") {
    throw malformed("unsupported compaction-history marker kind");
  }
  return {
    version: COMPACTION_HISTORY_MARKER_VERSION,
    kind,
    attempt_id: text(record.attempt_id, "compaction-history attempt_id"),
    summary_sha256: digest(
      record.summary_sha256,
      "compaction-history summary_sha256",
    ),
  };
}

function assertCommitHistoryMarkers(
  history: readonly CompactionProjectionMessageV1[],
  attemptId: string,
  summarySha256: string,
): void {
  const indexes: Partial<Record<CompactionHistoryMarkerV1["kind"], number>> = {};
  history.forEach((message, index) => {
    const marker = message.compactionHistory;
    if (marker === undefined || marker.attempt_id !== attemptId) return;
    if (
      marker.summary_sha256 !== summarySha256 ||
      indexes[marker.kind] !== undefined
    ) {
      throw malformed("compaction-history marker conflicts with its commit");
    }
    indexes[marker.kind] = index;
    if (
      (marker.kind === "boundary" && message.role !== "developer") ||
      (marker.kind === "summary" && message.role !== "user")
    ) {
      throw malformed("compaction-history marker has the wrong message role");
    }
  });
  if (
    indexes.boundary === undefined ||
    indexes.summary === undefined ||
    indexes.summary !== indexes.boundary + 1
  ) {
    throw malformed("compaction commit requires one adjacent boundary/summary marker pair");
  }
}

function readProjectionContent(
  value: unknown,
): CompactionProjectionMessageV1["content"] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw malformed("replacement-history content is unsupported");
  if (value.length > 4_096) throw malformed("replacement-history content has too many parts");
  return value.map((candidate) => {
    const part = plainRecord(candidate, "replacement-history content part");
    if (part.type === "text") {
      const exactPart = exact(candidate, ["type", "text"]);
      return { type: "text", text: boundedText(exactPart.text, "content text", MAX_COMPACTION_SOURCE_BYTES) };
    }
    if (part.type === "image_url") {
      const exactPart = exact(candidate, ["type", "image_url"]);
      const image = exact(exactPart.image_url, ["url"]);
      return { type: "image_url", image_url: { url: boundedText(image.url, "image URL", MAX_COMPACTION_SOURCE_BYTES) } };
    }
    if (part.type === "document") {
      const exactPart = exactOptional(
        candidate,
        ["type", "source"],
        ["title", "filename", "fallbackText", "fallbackTextTruncated", "fallbackTextError"],
        "document content part",
      );
      const source = exact(exactPart.source, ["type", "media_type", "data"]);
      if (source.type !== "base64" || source.media_type !== "application/pdf") {
        throw malformed("document content source is unsupported");
      }
      for (const booleanKey of ["fallbackTextTruncated"] as const) {
        if (exactPart[booleanKey] !== undefined && typeof exactPart[booleanKey] !== "boolean") {
          throw malformed(`${booleanKey} must be boolean`);
        }
      }
      return exactPart as unknown as Extract<CompactionProjectionMessageV1["content"], readonly unknown[]>[number];
    }
    throw malformed("replacement-history content part type is unsupported");
  });
}

function readProjectionToolCalls(value: unknown) {
  if (!Array.isArray(value) || value.length > 4_096) {
    throw malformed("replacement-history toolCalls is invalid");
  }
  const ids = new Set<string>();
  return value.map((candidate) => {
    const call = exactOptional(candidate, ["id", "name"], ["arguments"], "tool call");
    const id = text(call.id, "tool call id");
    if (ids.has(id)) throw malformed("replacement-history repeats a tool call id");
    ids.add(id);
    return {
      id,
      name: text(call.name, "tool call name"),
      ...(call.arguments !== undefined
        ? { arguments: boundedText(call.arguments, "tool arguments", MAX_COMPACTION_SOURCE_BYTES) }
        : {}),
    };
  });
}

function readBase(record: Record<string, unknown>) {
  if (record.format_version !== COMPACTION_EVENT_FORMAT_VERSION) {
    throw malformed("unsupported compaction event version or reader floor");
  }
  const minimumReaderRuntime = text(
    record.minimum_reader_runtime,
    "minimum_reader_runtime",
  );
  if (
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(
      minimumReaderRuntime,
    ) ||
    !semverGte(COMPACTION_READER_RUNTIME_CAPABILITY, minimumReaderRuntime)
  ) {
    throw malformed("unsupported compaction event version or reader floor");
  }
  return {
    format_version: COMPACTION_EVENT_FORMAT_VERSION,
    minimum_reader_runtime: minimumReaderRuntime,
    attempt_id: text(record.attempt_id, "attempt_id"),
    recorded_at_ms: integer(record.recorded_at_ms, "recorded_at_ms", 0),
  } as const;
}

function baseKeys(): readonly string[] {
  return ["format_version", "minimum_reader_runtime", "attempt_id", "recorded_at_ms"];
}

function exact(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const record = plainRecord(value, "compaction event");
  const keys = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw malformed("compaction event has unknown or missing fields");
  }
  return record;
}

function exactOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = plainRecord(value, label);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw malformed(`${label} has unknown or missing fields`);
  }
  return record;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw malformed(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw malformed(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096) {
    throw malformed(`${label} must be a bounded nonempty string`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw malformed(`${label} must be a bounded string`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256_PATTERN.test(result)) throw malformed(`${label} must be lowercase SHA-256`);
  return result;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw malformed(`${label} must be a bounded safe integer`);
  }
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw malformed(`${label} must be boolean`);
  return value;
}

function malformed(message: string): Error {
  return new Error(`malformed compaction rollout event: ${message}`);
}
