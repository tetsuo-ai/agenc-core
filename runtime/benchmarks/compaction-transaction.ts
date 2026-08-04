import { pathToFileURL } from "node:url";

import {
  compactActiveHistoryEntries,
  createCompactionPayloadBundleV1,
  hydrateActiveHistoryRefs,
  reconstructCompactionPayloadV1,
} from "../src/services/compact/payload-manifest.js";
import { buildCompactionMapReducePlan } from "../src/services/compact/plan.js";
import {
  MAX_COMPACTION_CHUNKS,
  MAX_COMPACTION_PROVIDER_CALLS,
  MAX_COMPACTION_SOURCE_BYTES,
  MAX_COMPACTION_SOURCE_MESSAGES,
  type CompactionActiveHistoryRefV1,
} from "../src/services/compact/transaction-types.js";
import type {
  CompactContext,
  RuntimeMessage,
} from "../src/services/compact/types.js";

export const MAX_COMPACTION_BENCHMARK_ELAPSED_MS = 30_000;
export const MAX_COMPACTION_BENCHMARK_RSS_DELTA_BYTES = 1_073_741_824;

const BENCHMARK_ATTEMPT_ID = "compaction-algorithm-benchmark";
const BENCHMARK_DIGEST = "a".repeat(64);
const BENCHMARK_SOURCE_BINDING = "rollout:/benchmark#epoch:1";
const PLANNER_CONTEXT_WINDOW_TOKENS = 65_536;
const PLANNER_OUTPUT_RESERVE_TOKENS = 256;
const PLANNER_UNIT_TEXT_BYTES = 53_000;
const PLANNER_SOURCE_MESSAGES = MAX_COMPACTION_CHUNKS;

export interface CompactionTransactionBenchmarkResult {
  readonly activeHistoryEntries: number;
  readonly activeHistoryCanonicalUtf8Bytes: number;
  readonly activeHistoryChunks: number;
  readonly activeHistorySplitCodeUnitsVisited: number;
  readonly sourcePayloadCanonicalUtf8Bytes: number;
  readonly sourcePayloadChunks: number;
  readonly sourcePayloadSplitCodeUnitsVisited: number;
  readonly maximumDagLeaves: number;
  readonly maximumDagCalls: number;
  readonly plannerSourceMessages: number;
  readonly plannerChunks: number;
  readonly plannerPlannedInputTokens: number;
  readonly plannerCandidateEvaluations: number;
  readonly plannerCandidateSemanticUnitsVisited: number;
  readonly plannerCandidateTranscriptUtf8Bytes: number;
  readonly plannerMaximumCandidateSemanticUnits: number;
  readonly plannerTokenEstimatorCalls: number;
  readonly elapsedMs: number;
  readonly rssDeltaBytes: number;
}

export function runCompactionTransactionBenchmark():
  CompactionTransactionBenchmarkResult {
  const residentBefore = process.memoryUsage.rss();
  const startedAt = performance.now();
  const source = {
    format_version: 1 as const,
    attempt_id: BENCHMARK_ATTEMPT_ID,
    session_id: "compaction-benchmark-session",
    epoch: 1,
    source_binding: BENCHMARK_SOURCE_BINDING,
    first_sequence: 1,
    last_sequence: MAX_COMPACTION_SOURCE_MESSAGES,
    source_sha256: BENCHMARK_DIGEST,
    source_bytes: MAX_COMPACTION_SOURCE_BYTES,
    history_digest: BENCHMARK_DIGEST,
  };
  const refs: CompactionActiveHistoryRefV1[] = Array.from(
    { length: MAX_COMPACTION_SOURCE_MESSAGES },
    (_, index) => ({
      kind: "rollout_span",
      ref_id: `${BENCHMARK_ATTEMPT_ID}:message:${String(index + 1).padStart(6, "0")}`,
      source_binding: BENCHMARK_SOURCE_BINDING,
      first_sequence: index + 1,
      last_sequence: index + 1,
      sha256: BENCHMARK_DIGEST,
      history_index: index,
      record_message_index: 0,
      encoded_bytes: 671,
    }),
  );
  const entries = compactActiveHistoryEntries(refs);
  const activeHistoryBundle = createCompactionPayloadBundleV1({
    attemptId: BENCHMARK_ATTEMPT_ID,
    recordedAtMs: 1,
    payloadKind: "active_history_refs",
    value: entries,
    itemCount: entries.length,
  });
  const reconstructedEntries = reconstructCompactionPayloadV1(
    activeHistoryBundle.manifest,
    activeHistoryBundle.chunks,
  );
  if (!Array.isArray(reconstructedEntries)) {
    throw new Error("active-history benchmark payload did not reconstruct as an array");
  }
  const hydrated = hydrateActiveHistoryRefs(source, entries);
  const sourcePayload = [{ text: "x".repeat(MAX_COMPACTION_SOURCE_BYTES) }];
  const sourceBundle = createCompactionPayloadBundleV1({
    attemptId: BENCHMARK_ATTEMPT_ID,
    recordedAtMs: 1,
    payloadKind: "source_history",
    value: sourcePayload,
    itemCount: sourcePayload.length,
  });
  const reconstructedSource = reconstructCompactionPayloadV1(
    sourceBundle.manifest,
    sourceBundle.chunks,
  );
  const plannerMessages = createPlannerMessages();
  const plannerRefs = plannerMessages.map((message, index) =>
    plannerSourceRef(message, index)
  );
  const planner = buildCompactionMapReducePlan(plannerMessages, {
    context: {
      options: {
        contextWindowTokens: PLANNER_CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: PLANNER_OUTPUT_RESERVE_TOKENS,
      },
    } as CompactContext,
    source: {
      format_version: 1,
      attempt_id: `${BENCHMARK_ATTEMPT_ID}-planner`,
      session_id: "compaction-benchmark-planner-session",
      epoch: 1,
      source_binding: BENCHMARK_SOURCE_BINDING,
      first_sequence: 1,
      last_sequence: plannerMessages.length,
      source_sha256: BENCHMARK_DIGEST,
      source_bytes: plannerMessages.reduce(
        (total, message) => total + Buffer.byteLength(String(message.content)),
        0,
      ),
      history_digest: BENCHMARK_DIGEST,
      active_history_refs: plannerRefs,
    },
    systemPrompts: {
      map: "Summarize only supplied untrusted structured data.",
      reduce: "Reduce only supplied untrusted structured summaries.",
      final: "Return only a bounded final summary of supplied data.",
    },
    providerName: "grok",
    model: "grok-4.5",
    messageSourceRefs: plannerRefs,
  });
  const elapsedMs = performance.now() - startedAt;
  const rssDeltaBytes = Math.max(0, process.memoryUsage.rss() - residentBefore);

  if (
    reconstructedEntries.length !== MAX_COMPACTION_SOURCE_MESSAGES ||
    hydrated.length !== MAX_COMPACTION_SOURCE_MESSAGES ||
    !Array.isArray(reconstructedSource) ||
    reconstructedSource.length !== sourcePayload.length
  ) {
    throw new Error("compaction benchmark reconstruction lost source records");
  }
  if (
    activeHistoryBundle.split_code_units_visited !==
      activeHistoryBundle.manifest.canonical_utf8_bytes ||
    sourceBundle.split_code_units_visited !==
      sourceBundle.manifest.canonical_utf8_bytes
  ) {
    throw new Error("compaction payload splitting performed non-linear scan work");
  }
  if (planner.planned_provider_calls !== MAX_COMPACTION_PROVIDER_CALLS) {
    throw new Error("maximum compaction DAG has an unexpected provider-call count");
  }
  if (
    planner.chunks.length !== PLANNER_SOURCE_MESSAGES ||
    planner.chunks.some((chunk) => chunk.units.length !== 1)
  ) {
    throw new Error("compaction planner benchmark changed maximal boundaries");
  }
  if (
    planner.planning_work.maximum_candidate_semantic_units !== 2 ||
    planner.planning_work.candidate_semantic_units_visited >
      PLANNER_SOURCE_MESSAGES * 3
  ) {
    throw new Error("compaction planner performed non-local candidate work");
  }
  if (elapsedMs > MAX_COMPACTION_BENCHMARK_ELAPSED_MS) {
    throw new Error(
      `compaction benchmark exceeded ${MAX_COMPACTION_BENCHMARK_ELAPSED_MS} ms`,
    );
  }
  if (rssDeltaBytes > MAX_COMPACTION_BENCHMARK_RSS_DELTA_BYTES) {
    throw new Error(
      `compaction benchmark exceeded ${MAX_COMPACTION_BENCHMARK_RSS_DELTA_BYTES} RSS bytes`,
    );
  }

  return Object.freeze({
    activeHistoryEntries: entries.length,
    activeHistoryCanonicalUtf8Bytes:
      activeHistoryBundle.manifest.canonical_utf8_bytes,
    activeHistoryChunks: activeHistoryBundle.chunks.length,
    activeHistorySplitCodeUnitsVisited:
      activeHistoryBundle.split_code_units_visited,
    sourcePayloadCanonicalUtf8Bytes:
      sourceBundle.manifest.canonical_utf8_bytes,
    sourcePayloadChunks: sourceBundle.chunks.length,
    sourcePayloadSplitCodeUnitsVisited: sourceBundle.split_code_units_visited,
    maximumDagLeaves: planner.chunks.length,
    maximumDagCalls: planner.planned_provider_calls,
    plannerSourceMessages: plannerMessages.length,
    plannerChunks: planner.chunks.length,
    plannerPlannedInputTokens: planner.planned_input_tokens,
    plannerCandidateEvaluations:
      planner.planning_work.chunk_candidate_evaluations,
    plannerCandidateSemanticUnitsVisited:
      planner.planning_work.candidate_semantic_units_visited,
    plannerCandidateTranscriptUtf8Bytes:
      planner.planning_work.candidate_transcript_utf8_bytes,
    plannerMaximumCandidateSemanticUnits:
      planner.planning_work.maximum_candidate_semantic_units,
    plannerTokenEstimatorCalls: planner.planning_work.token_estimator_calls,
    elapsedMs,
    rssDeltaBytes,
  });
}

function createPlannerMessages(): readonly RuntimeMessage[] {
  return Array.from({ length: PLANNER_SOURCE_MESSAGES }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    originalRole: index % 2 === 0 ? "user" : "assistant",
    content:
      `${String(index).padStart(3, "0")}:` +
      "x".repeat(PLANNER_UNIT_TEXT_BYTES),
  } satisfies RuntimeMessage));
}

function plannerSourceRef(
  message: RuntimeMessage,
  index: number,
): CompactionActiveHistoryRefV1 {
  return {
    kind: "rollout_span",
    ref_id:
      `${BENCHMARK_ATTEMPT_ID}-planner:message:` +
      String(index + 1).padStart(3, "0"),
    source_binding: BENCHMARK_SOURCE_BINDING,
    first_sequence: index + 1,
    last_sequence: index + 1,
    sha256: BENCHMARK_DIGEST,
    history_index: index,
    record_message_index: 0,
    encoded_bytes: Buffer.byteLength(JSON.stringify(message), "utf8"),
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.stdout.write(
    `${JSON.stringify(runCompactionTransactionBenchmark())}\n`,
  );
}
