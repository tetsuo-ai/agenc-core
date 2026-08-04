import { describe, expect, it } from "vitest";

import {
  compactActiveHistoryEntries,
  createCompactionPayloadBundleV1,
  hydrateActiveHistoryRefs,
  reconstructCompactionPayloadV1,
} from "../../../src/services/compact/payload-manifest.js";
import {
  MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES,
  COMPACTION_MINIMUM_READER_RUNTIME,
  COMPACTION_ROLLBACK_RETENTION_MS,
  type CompactionIntentV1,
  type CompactionActiveHistoryRefV1,
  type CompactionPayloadBundleV1,
  type CompactionPayloadChunkV1,
  type CompactionPersistedIntentV1,
} from "../../../src/services/compact/transaction-types.js";
import {
  readCompactionPersistedCommittedV1,
  readCompactionPersistedIntentV1,
  readCompactionPersistedRollbackCommittedV1,
} from "../../../src/session/compaction-event-reader.js";
import { validateCanonicalJournalText } from "../../../src/state/recovery-journal-contract.js";

const DIGEST = "a".repeat(64);

describe("compaction canonical payload manifests", () => {
  it("round-trips a multi-record payload and rejects missing or reordered chunks", () => {
    const value = Array.from({ length: 8 }, (_, index) => ({
      index,
      text: `${index}:${"x".repeat(700_000)}`,
    }));
    const bundle = createCompactionPayloadBundleV1({
      attemptId: "manifest-roundtrip",
      recordedAtMs: 1,
      payloadKind: "source_history",
      value,
      itemCount: value.length,
    });
    expect(bundle.chunks.length).toBeGreaterThan(1);
    expect(bundle.chunks.every((chunk) =>
      serializedPayloadChunkUtf8Bytes(chunk) <=
        MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES
    )).toBe(true);
    expect(reconstructCompactionPayloadV1(bundle.manifest, bundle.chunks))
      .toEqual(value);
    expect(() => reconstructCompactionPayloadV1(
      bundle.manifest,
      bundle.chunks.slice(1),
    )).toThrow(/chunk count/i);
    expect(() => reconstructCompactionPayloadV1(
      bundle.manifest,
      [bundle.chunks[1]!, bundle.chunks[0]!, ...bundle.chunks.slice(2)],
    )).toThrow(/reordered|mismatched/i);
  });

  it("measures the serialized outer chunk record at the exact limit and plus one", () => {
    const seed = createCompactionPayloadBundleV1({
      attemptId: "manifest-line-boundary",
      recordedAtMs: 1,
      payloadKind: "replacement_history",
      value: [],
      itemCount: 0,
    }).chunks[0]!;
    const empty = {
      ...seed,
      fragment_utf8_bytes: 0,
      canonical_json_fragment: "",
    };
    const baseBytes = serializedPayloadChunkUtf8Bytes(empty);
    const exactFragment = "x".repeat(
      MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES - baseBytes,
    );
    const exact = {
      ...empty,
      fragment_utf8_bytes: exactFragment.length,
      canonical_json_fragment: exactFragment,
    };
    // The decimal fragment length field grows compared with the empty seed.
    const overshoot = serializedPayloadChunkUtf8Bytes(exact) -
      MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES;
    const adjusted = {
      ...exact,
      fragment_utf8_bytes: exactFragment.length - overshoot,
      canonical_json_fragment: overshoot === 0
        ? exactFragment
        : exactFragment.slice(0, -overshoot),
    };
    expect(serializedPayloadChunkUtf8Bytes(adjusted))
      .toBe(MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES);
    expect(serializedPayloadChunkUtf8Bytes({
      ...adjusted,
      fragment_utf8_bytes: adjusted.fragment_utf8_bytes + 1,
      canonical_json_fragment: `${adjusted.canonical_json_fragment}x`,
    })).toBe(MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES + 1);
  });

  it("keeps one hundred thousand active refs compact and hydrates deterministically", () => {
    const source = {
      format_version: 1 as const,
      attempt_id: "compact-ref-scale",
      session_id: "session-ref-scale",
      epoch: 1,
      source_binding: `rollout:/${"p".repeat(4_000)}#epoch:1`,
      first_sequence: 1,
      last_sequence: 100_000,
      source_sha256: DIGEST,
      source_bytes: 67_108_864,
      history_digest: DIGEST,
    };
    const refs: CompactionActiveHistoryRefV1[] = Array.from(
      { length: 100_000 },
      (_, index) => ({
        kind: "rollout_span",
        ref_id: `${source.attempt_id}:message:${String(index + 1).padStart(6, "0")}`,
        source_binding: source.source_binding,
        first_sequence: index + 1,
        last_sequence: index + 1,
        sha256: DIGEST,
        history_index: index,
        record_message_index: 0,
        encoded_bytes: 671,
      }),
    );
    const entries = compactActiveHistoryEntries(refs);
    const bundle = createCompactionPayloadBundleV1({
      attemptId: source.attempt_id,
      recordedAtMs: 1,
      payloadKind: "active_history_refs",
      value: entries,
      itemCount: entries.length,
    });
    expect(bundle.manifest.item_count).toBe(100_000);
    expect(bundle.manifest.canonical_utf8_bytes).toBeLessThan(20_000_000);
    expect(bundle.chunks.length).toBeLessThan(10);
    expect(hydrateActiveHistoryRefs(source, entries)).toEqual(refs);
  }, 30_000);

  it("rejects orphaned, duplicated, and reordered canonical chunk rows", () => {
    const bundle = createCompactionPayloadBundleV1({
      attemptId: "manifest-lifecycle",
      recordedAtMs: 1,
      payloadKind: "source_history",
      value: [{ content: "x".repeat(5_000_000) }],
      itemCount: 1,
    });
    const chunkLines = bundle.chunks.map(chunkLine);
    expect(() => validateCanonicalJournalText(chunkLines.join("")))
      .toThrow(/precedes its intent/i);

    const intentLine = rolloutLine("compaction_intent", manifestIntent());
    expect(() => validateCanonicalJournalText(
      `${intentLine}${chunkLines[0]}${chunkLines[0]}`,
    )).toThrow(/contiguous|duplicated|missing|reordered|mismatched/i);
    expect(() => validateCanonicalJournalText(
      `${intentLine}${chunkLines[1]}${chunkLines[0]}`,
    )).toThrow(/duplicated|missing|reordered|mismatched/i);
    expect(validateCanonicalJournalText(`${intentLine}${chunkLines[0]}`))
      .toMatchObject({ recordCount: 2 });
  });

  it("strictly reads manifest-backed persistence records without inline payloads", () => {
    const bundles = persistedPayloadBundles();
    const intent = persistedIntent(bundles.activeRefs, bundles.sourceHistory);
    expect(readCompactionPersistedIntentV1(intent)).toEqual(intent);

    const committedAtMs = 10;
    const commit = {
      ...eventBase(intent.attempt_id, committedAtMs),
      committed_at_ms: committedAtMs,
      rollback_retention_deadline_ms:
        committedAtMs + COMPACTION_ROLLBACK_RETENTION_MS,
      source: intent.source,
      selected_history_indexes: intent.selected_history_indexes,
      policy_digest: intent.policy_digest,
      configuration_digest: intent.configuration_digest,
      final_summary_manifest: bundles.finalSummary.manifest,
      summary_dag_manifest: bundles.summaryDag.manifest,
      accounting: {
        accounting_ref: intent.accounting_ref,
        source_tokens: 10_000,
        candidate_tokens: 1_000,
        context_window_tokens: 20_000,
        reserved_output_tokens: 1_000,
        source: "provider_exact",
        confidence: "exact",
      },
      replacement_history_manifest: bundles.replacementHistory.manifest,
      cleanup_state: "pending",
    } as const;
    expect(readCompactionPersistedCommittedV1(commit)).toEqual(commit);

    const rollback = {
      ...eventBase(intent.attempt_id, 20),
      commit_sha256: DIGEST,
      source_sha256: intent.source.source_sha256,
      history_digest: intent.source.history_digest,
      source_session_id: intent.source.session_id,
      source_epoch: intent.source.epoch,
      rollback_mode: "same_session",
      target_session_id: intent.source.session_id,
      source_history_manifest: bundles.sourceHistory.manifest,
    } as const;
    expect(readCompactionPersistedRollbackCommittedV1(rollback))
      .toEqual(rollback);

    expect(() => readCompactionPersistedIntentV1({
      ...intent,
      source_history: [],
    })).toThrow(/unknown or missing fields/i);
    expect(() => readCompactionPersistedCommittedV1({
      ...commit,
      final_summary_manifest: {
        ...commit.final_summary_manifest,
        payload_kind: "summary_dag",
      },
    })).toThrow(/wrong kind|digest/i);
    expect(() => readCompactionPersistedRollbackCommittedV1({
      ...rollback,
      source_history: [],
    })).toThrow(/unknown or missing fields/i);
  });

  it("round-trips hostile escaped text and rejects non-I-JSON surrogates", () => {
    const value = [{
      text: "quote:\" slash:\\ controls:\b\t\n\f\r\u0000 unicode:雪 emoji:🚀",
    }];
    const bundle = createCompactionPayloadBundleV1({
      attemptId: "manifest-hostile-text",
      recordedAtMs: 1,
      payloadKind: "replacement_history",
      value,
      itemCount: 1,
    });
    expect(reconstructCompactionPayloadV1(bundle.manifest, bundle.chunks))
      .toEqual(value);
    expect(bundle.chunks.every((chunk) =>
      serializedPayloadChunkUtf8Bytes(chunk) <=
        MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES
    )).toBe(true);
    expect(() => createCompactionPayloadBundleV1({
      attemptId: "manifest-lone-surrogate",
      recordedAtMs: 1,
      payloadKind: "replacement_history",
      value: [{ text: "\ud800" }],
      itemCount: 1,
    })).toThrow(/surrogate/i);
  });

  it("splits a 64 MiB payload with linear work and bounded resident growth", () => {
    const residentBefore = process.memoryUsage.rss();
    const value = [{ text: "x".repeat(67_108_864) }];
    const bundle = createCompactionPayloadBundleV1({
      attemptId: "manifest-64mib-benchmark",
      recordedAtMs: 1,
      payloadKind: "source_history",
      value,
      itemCount: 1,
    });
    const residentGrowth = process.memoryUsage.rss() - residentBefore;
    expect(bundle.split_code_units_visited)
      .toBe(bundle.manifest.canonical_utf8_bytes);
    expect(bundle.chunks.length).toBeLessThanOrEqual(32);
    expect(bundle.chunks.every((chunk) =>
      serializedPayloadChunkUtf8Bytes(chunk) <=
        MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES
    )).toBe(true);
    expect(residentGrowth).toBeLessThan(805_306_368);
  }, 30_000);
});

function persistedPayloadBundles(): {
  readonly activeRefs: CompactionPayloadBundleV1;
  readonly sourceHistory: CompactionPayloadBundleV1;
  readonly finalSummary: CompactionPayloadBundleV1;
  readonly summaryDag: CompactionPayloadBundleV1;
  readonly replacementHistory: CompactionPayloadBundleV1;
} {
  const attemptId = "persisted-manifest-records";
  const create = (
    payloadKind: Parameters<typeof createCompactionPayloadBundleV1>[0]["payloadKind"],
    value: unknown,
    itemCount: number,
  ): CompactionPayloadBundleV1 => createCompactionPayloadBundleV1({
    attemptId,
    recordedAtMs: 1,
    payloadKind,
    value,
    itemCount,
  });
  return {
    activeRefs: create("active_history_refs", [{
      sequence: 1,
      record_message_index: 0,
      encoded_bytes: 1,
      sha256: DIGEST,
    }], 1),
    sourceHistory: create("source_history", [{ role: "user", content: "x" }], 1),
    finalSummary: create("final_summary", { summary_sha256: DIGEST }, 1),
    summaryDag: create("summary_dag", { dag_sha256: DIGEST }, 1),
    replacementHistory: create(
      "replacement_history",
      [{ role: "assistant", content: "summary" }],
      1,
    ),
  };
}

function persistedIntent(
  activeRefs: CompactionPayloadBundleV1,
  sourceHistory: CompactionPayloadBundleV1,
): CompactionPersistedIntentV1 {
  const attemptId = activeRefs.manifest.attempt_id;
  return {
    ...eventBase(attemptId, 1),
    source: {
      format_version: 1,
      attempt_id: attemptId,
      session_id: "persisted-manifest-session",
      epoch: 1,
      source_binding: "rollout:/persisted-manifest#epoch:1",
      first_sequence: 1,
      last_sequence: 1,
      source_sha256: DIGEST,
      source_bytes: 1,
      history_digest: DIGEST,
      active_history_refs_manifest: activeRefs.manifest,
    },
    source_history_manifest: sourceHistory.manifest,
    policy_digest: DIGEST,
    configuration_digest: DIGEST,
    accounting_ref: DIGEST,
    automatic: false,
    selected_history_indexes: [0],
    admission_required: true,
    planned_provider_calls: 1,
  };
}

function eventBase(attemptId: string, recordedAtMs: number) {
  return {
    format_version: 1 as const,
    minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
    attempt_id: attemptId,
    recorded_at_ms: recordedAtMs,
  };
}

function manifestIntent(): CompactionIntentV1 {
  const attemptId = "manifest-lifecycle";
  return {
    format_version: 1,
    minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
    attempt_id: attemptId,
    recorded_at_ms: 1,
    source: {
      format_version: 1,
      attempt_id: attemptId,
      session_id: "manifest-session",
      epoch: 1,
      source_binding: "rollout:/manifest#epoch:1",
      first_sequence: 1,
      last_sequence: 1,
      source_sha256: DIGEST,
      source_bytes: 1,
      history_digest: DIGEST,
      active_history_refs: [{
        kind: "rollout_span",
        ref_id: `${attemptId}:message:000001`,
        source_binding: "rollout:/manifest#epoch:1",
        first_sequence: 1,
        last_sequence: 1,
        sha256: DIGEST,
        history_index: 0,
        record_message_index: 0,
        encoded_bytes: 1,
      }],
    },
    policy_digest: DIGEST,
    configuration_digest: DIGEST,
    accounting_ref: DIGEST,
    automatic: false,
    selected_history_indexes: [0],
    admission_required: true,
    planned_provider_calls: 1,
  };
}

function chunkLine(chunk: unknown): string {
  return rolloutLine("compaction_payload_chunk", chunk);
}

function serializedPayloadChunkUtf8Bytes(
  chunk: CompactionPayloadChunkV1,
): number {
  return Buffer.byteLength(JSON.stringify({
    type: "compaction_payload_chunk",
    payload: chunk,
    eventVersion: 2,
  }), "utf8");
}

function rolloutLine(type: string, payload: unknown): string {
  return `${JSON.stringify({ type, payload, eventVersion: 2 })}\n`;
}
