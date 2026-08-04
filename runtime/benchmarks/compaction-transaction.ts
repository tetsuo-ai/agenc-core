import { pathToFileURL } from "node:url";

import {
  compactActiveHistoryEntries,
  createCompactionPayloadBundleV1,
  hydrateActiveHistoryRefs,
  reconstructCompactionPayloadV1,
} from "../src/services/compact/payload-manifest.js";
import { compactionMapReduceTopology } from "../src/services/compact/plan.js";
import {
  MAX_COMPACTION_CHUNKS,
  MAX_COMPACTION_PROVIDER_CALLS,
  MAX_COMPACTION_SOURCE_BYTES,
  MAX_COMPACTION_SOURCE_MESSAGES,
  type CompactionActiveHistoryRefV1,
} from "../src/services/compact/transaction-types.js";

export const MAX_COMPACTION_BENCHMARK_ELAPSED_MS = 30_000;
export const MAX_COMPACTION_BENCHMARK_RSS_DELTA_BYTES = 1_073_741_824;

const BENCHMARK_ATTEMPT_ID = "compaction-algorithm-benchmark";
const BENCHMARK_DIGEST = "a".repeat(64);
const BENCHMARK_SOURCE_BINDING = "rollout:/benchmark#epoch:1";

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
  const topology = compactionMapReduceTopology(MAX_COMPACTION_CHUNKS);
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
  if (topology.calls !== MAX_COMPACTION_PROVIDER_CALLS) {
    throw new Error("maximum compaction DAG has an unexpected provider-call count");
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
    maximumDagLeaves: MAX_COMPACTION_CHUNKS,
    maximumDagCalls: topology.calls,
    elapsedMs,
    rssDeltaBytes,
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.stdout.write(
    `${JSON.stringify(runCompactionTransactionBenchmark())}\n`,
  );
}
