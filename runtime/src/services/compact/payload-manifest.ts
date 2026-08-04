import {
  COMPACTION_EVENT_FORMAT_VERSION,
  COMPACTION_MINIMUM_READER_RUNTIME,
  COMPACTION_PAYLOAD_CHUNK_DIGEST_DOMAIN,
  COMPACTION_PAYLOAD_DIGEST_DOMAIN,
  COMPACTION_PAYLOAD_FORMAT_VERSION,
  COMPACTION_PAYLOAD_MANIFEST_DIGEST_DOMAIN,
  MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES,
  MAX_COMPACTION_PAYLOAD_CANONICAL_UTF8_BYTES,
  MAX_COMPACTION_PAYLOAD_CHUNKS,
  type CompactionActiveHistoryEntryV1,
  type CompactionActiveHistoryRefV1,
  type CompactionPayloadChunkV1,
  type CompactionPayloadKind,
  type CompactionPayloadManifestV1,
  type CompactionSourceAuthorityV1,
  CompactionTransactionError,
} from "./transaction-types.js";
import {
  digestWithDomain,
  sha256Hex,
} from "./summary-v1.js";
import { canonicalizeJson as canonicalizePayloadJson } from "../../eval-contract/canonical-json.js";

const COMPACTION_ROLLOUT_ITEM_VERSION = 2;
const INITIAL_CHUNK_DIGEST = "0".repeat(64);

export interface CompactionPayloadBundleV1 {
  readonly manifest: CompactionPayloadManifestV1;
  readonly chunks: readonly CompactionPayloadChunkV1[];
}

export function createCompactionPayloadBundleV1(params: {
  readonly attemptId: string;
  readonly recordedAtMs: number;
  readonly payloadKind: CompactionPayloadKind;
  readonly value: unknown;
  readonly itemCount: number;
}): CompactionPayloadBundleV1 {
  const canonicalJson = canonicalizePayloadJson(params.value);
  const canonicalBytes = Buffer.byteLength(canonicalJson, "utf8");
  if (canonicalBytes > MAX_COMPACTION_PAYLOAD_CANONICAL_UTF8_BYTES) {
    throw new CompactionTransactionError(
      "source_limit_exceeded",
      `compaction ${params.payloadKind} payload exceeds ${MAX_COMPACTION_PAYLOAD_CANONICAL_UTF8_BYTES} canonical UTF-8 bytes`,
    );
  }
  if (!Number.isSafeInteger(params.itemCount) || params.itemCount < 0) {
    throw new CompactionTransactionError(
      "source_limit_exceeded",
      "compaction payload item count is invalid",
    );
  }
  const payloadSha256 = digestWithDomain(COMPACTION_PAYLOAD_DIGEST_DOMAIN, {
    attempt_id: params.attemptId,
    payload_kind: params.payloadKind,
    canonical_json: canonicalJson,
  });
  const fragments = splitCanonicalPayload(params, payloadSha256, canonicalJson);
  let previousChunkSha256 = INITIAL_CHUNK_DIGEST;
  const chunks = fragments.map((fragment, chunkIndex) => {
    const withoutDigest = {
      format_version: COMPACTION_EVENT_FORMAT_VERSION,
      minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
      attempt_id: params.attemptId,
      recorded_at_ms: params.recordedAtMs,
      payload_kind: params.payloadKind,
      payload_sha256: payloadSha256,
      chunk_index: chunkIndex,
      chunk_count: fragments.length,
      previous_chunk_sha256: previousChunkSha256,
      fragment_utf8_bytes: Buffer.byteLength(fragment, "utf8"),
      canonical_json_fragment: fragment,
    } as const;
    const chunkSha256 = digestWithDomain(
      COMPACTION_PAYLOAD_CHUNK_DIGEST_DOMAIN,
      withoutDigest,
    );
    previousChunkSha256 = chunkSha256;
    const chunk = { ...withoutDigest, chunk_sha256: chunkSha256 };
    assertCompactionPayloadChunkLineBound(chunk);
    return chunk;
  });
  const manifestWithoutDigest = {
    version: COMPACTION_PAYLOAD_FORMAT_VERSION,
    attempt_id: params.attemptId,
    payload_kind: params.payloadKind,
    payload_sha256: payloadSha256,
    canonical_utf8_bytes: canonicalBytes,
    item_count: params.itemCount,
    chunk_count: chunks.length,
    final_chunk_sha256: chunks.at(-1)?.chunk_sha256 ?? INITIAL_CHUNK_DIGEST,
  } as const;
  return {
    chunks,
    manifest: {
      ...manifestWithoutDigest,
      manifest_sha256: digestWithDomain(
        COMPACTION_PAYLOAD_MANIFEST_DIGEST_DOMAIN,
        manifestWithoutDigest,
      ),
    },
  };
}

export function reconstructCompactionPayloadV1(
  manifest: CompactionPayloadManifestV1,
  chunks: readonly CompactionPayloadChunkV1[],
): unknown {
  verifyCompactionPayloadManifestV1(manifest);
  if (chunks.length !== manifest.chunk_count) {
    throw invalidPayload("payload chunk count does not match its manifest");
  }
  let previousChunkSha256 = INITIAL_CHUNK_DIGEST;
  let canonicalJson = "";
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    verifyCompactionPayloadChunkV1(chunk);
    if (
      chunk.attempt_id !== manifest.attempt_id ||
      chunk.payload_kind !== manifest.payload_kind ||
      chunk.payload_sha256 !== manifest.payload_sha256 ||
      chunk.chunk_index !== index ||
      chunk.chunk_count !== manifest.chunk_count ||
      chunk.previous_chunk_sha256 !== previousChunkSha256
    ) {
      throw invalidPayload("payload chunk chain is missing, reordered, or mismatched");
    }
    canonicalJson += chunk.canonical_json_fragment;
    previousChunkSha256 = chunk.chunk_sha256;
  }
  if (previousChunkSha256 !== manifest.final_chunk_sha256) {
    throw invalidPayload("payload final chunk does not match its manifest");
  }
  if (Buffer.byteLength(canonicalJson, "utf8") !== manifest.canonical_utf8_bytes) {
    throw invalidPayload("payload canonical byte count does not match its manifest");
  }
  if (
    digestWithDomain(COMPACTION_PAYLOAD_DIGEST_DOMAIN, {
      attempt_id: manifest.attempt_id,
      payload_kind: manifest.payload_kind,
      canonical_json: canonicalJson,
    }) !== manifest.payload_sha256
  ) {
    throw invalidPayload("payload digest does not match its manifest");
  }
  let value: unknown;
  try {
    value = JSON.parse(canonicalJson);
  } catch (error) {
    throw invalidPayload("payload canonical JSON is malformed", error);
  }
  if (canonicalizePayloadJson(value) !== canonicalJson) {
    throw invalidPayload("payload text is not canonical JSON");
  }
  if (
    Array.isArray(value) && value.length !== manifest.item_count ||
    !Array.isArray(value) && manifest.item_count !== 1
  ) {
    throw invalidPayload("payload item count does not match its manifest");
  }
  return value;
}

export function verifyCompactionPayloadChunkV1(
  chunk: CompactionPayloadChunkV1,
): void {
  const { chunk_sha256: chunkSha256, ...withoutDigest } = chunk;
  if (
    Buffer.byteLength(chunk.canonical_json_fragment, "utf8") !==
      chunk.fragment_utf8_bytes ||
    digestWithDomain(COMPACTION_PAYLOAD_CHUNK_DIGEST_DOMAIN, withoutDigest) !==
      chunkSha256
  ) {
    throw invalidPayload("payload chunk byte count or digest is invalid");
  }
  assertCompactionPayloadChunkLineBound(chunk);
}

export function verifyCompactionPayloadManifestV1(
  manifest: CompactionPayloadManifestV1,
): void {
  const { manifest_sha256: manifestSha256, ...withoutDigest } = manifest;
  if (
    digestWithDomain(COMPACTION_PAYLOAD_MANIFEST_DIGEST_DOMAIN, withoutDigest) !==
      manifestSha256
  ) {
    throw invalidPayload("payload manifest digest is invalid");
  }
}

export function compactActiveHistoryEntries(
  refs: readonly CompactionActiveHistoryRefV1[],
): readonly CompactionActiveHistoryEntryV1[] {
  return refs.map((ref, historyIndex) => {
    if (
      ref.history_index !== historyIndex ||
      ref.first_sequence !== ref.last_sequence
    ) {
      throw invalidPayload("active history refs are not compactly representable");
    }
    return {
      sequence: ref.first_sequence,
      record_message_index: ref.record_message_index,
      encoded_bytes: ref.encoded_bytes,
      sha256: ref.sha256,
    };
  });
}

export function hydrateActiveHistoryRefs(
  source: Omit<CompactionSourceAuthorityV1, "active_history_refs">,
  entries: readonly CompactionActiveHistoryEntryV1[],
): readonly CompactionActiveHistoryRefV1[] {
  return entries.map((entry, historyIndex) => ({
    kind: "rollout_span",
    ref_id: `${source.attempt_id}:message:${String(historyIndex + 1).padStart(6, "0")}`,
    source_binding: source.source_binding,
    first_sequence: entry.sequence,
    last_sequence: entry.sequence,
    sha256: entry.sha256,
    history_index: historyIndex,
    record_message_index: entry.record_message_index,
    encoded_bytes: entry.encoded_bytes,
  }));
}

export function compactionPayloadChunkLineUtf8Bytes(
  chunk: CompactionPayloadChunkV1,
): number {
  return Buffer.byteLength(JSON.stringify({
    type: "compaction_payload_chunk",
    payload: chunk,
    eventVersion: COMPACTION_ROLLOUT_ITEM_VERSION,
  }), "utf8");
}

function splitCanonicalPayload(
  params: Pick<
    Parameters<typeof createCompactionPayloadBundleV1>[0],
    "attemptId" | "recordedAtMs" | "payloadKind"
  >,
  payloadSha256: string,
  canonicalJson: string,
): readonly string[] {
  const fragments: string[] = [];
  let offset = 0;
  while (offset < canonicalJson.length || fragments.length === 0) {
    let low = offset;
    let high = canonicalJson.length;
    let acceptedEnd = offset;
    while (low <= high) {
      const end = low + Math.floor((high - low) / 2);
      const candidate = canonicalJson.slice(offset, end);
      const placeholder: CompactionPayloadChunkV1 = {
        format_version: COMPACTION_EVENT_FORMAT_VERSION,
        minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
        attempt_id: params.attemptId,
        recorded_at_ms: params.recordedAtMs,
        payload_kind: params.payloadKind,
        payload_sha256: payloadSha256,
        chunk_index: MAX_COMPACTION_PAYLOAD_CHUNKS - 1,
        chunk_count: MAX_COMPACTION_PAYLOAD_CHUNKS,
        previous_chunk_sha256: INITIAL_CHUNK_DIGEST,
        fragment_utf8_bytes: Buffer.byteLength(candidate, "utf8"),
        canonical_json_fragment: candidate,
        chunk_sha256: INITIAL_CHUNK_DIGEST,
      };
      if (
        compactionPayloadChunkLineUtf8Bytes(placeholder) <=
        MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES
      ) {
        acceptedEnd = end;
        low = end + 1;
      } else {
        high = end - 1;
      }
    }
    if (acceptedEnd === offset && offset < canonicalJson.length) {
      throw invalidPayload("payload fragment cannot fit the canonical line limit");
    }
    fragments.push(canonicalJson.slice(offset, acceptedEnd));
    offset = acceptedEnd;
    if (fragments.length > MAX_COMPACTION_PAYLOAD_CHUNKS) {
      throw invalidPayload("payload requires too many canonical chunks");
    }
  }
  return fragments;
}

function assertCompactionPayloadChunkLineBound(
  chunk: CompactionPayloadChunkV1,
): void {
  const bytes = compactionPayloadChunkLineUtf8Bytes(chunk);
  if (bytes > MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES) {
    throw invalidPayload(
      `payload chunk requires ${bytes} bytes; canonical line limit is ${MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES}`,
    );
  }
}

function invalidPayload(message: string, cause?: unknown): CompactionTransactionError {
  return new CompactionTransactionError(
    "source_limit_exceeded",
    message,
    cause === undefined ? undefined : { cause },
  );
}

/** Hash-only helper for evidence without retaining canonical payload text. */
export function compactionPayloadEvidenceSha256(value: unknown): string {
  return sha256Hex(canonicalizePayloadJson(value));
}
