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
  type CompactionPayloadBundleV1,
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
  const payloadSha256 = compactionPayloadSha256(
    params.attemptId,
    params.payloadKind,
    canonicalJson,
  );
  const split = splitCanonicalPayload(params, payloadSha256, canonicalJson);
  const fragments = split.fragments;
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
    split_code_units_visited: split.codeUnitsVisited,
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
  const fragments: string[] = [];
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
    fragments.push(chunk.canonical_json_fragment);
    previousChunkSha256 = chunk.chunk_sha256;
  }
  if (previousChunkSha256 !== manifest.final_chunk_sha256) {
    throw invalidPayload("payload final chunk does not match its manifest");
  }
  const canonicalJson = fragments.join("");
  if (Buffer.byteLength(canonicalJson, "utf8") !== manifest.canonical_utf8_bytes) {
    throw invalidPayload("payload canonical byte count does not match its manifest");
  }
  if (
    compactionPayloadSha256(
      manifest.attempt_id,
      manifest.payload_kind,
      canonicalJson,
    ) !== manifest.payload_sha256
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

function compactionPayloadChunkLineUtf8Bytes(
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
): { readonly fragments: readonly string[]; readonly codeUnitsVisited: number } {
  const fragments: string[] = [];
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
    fragment_utf8_bytes: MAX_COMPACTION_PAYLOAD_CANONICAL_UTF8_BYTES,
    canonical_json_fragment: "",
    chunk_sha256: INITIAL_CHUNK_DIGEST,
  };
  const escapedFragmentBudget = MAX_COMPACTION_CANONICAL_LINE_UTF8_BYTES -
    compactionPayloadChunkLineUtf8Bytes(placeholder);
  if (escapedFragmentBudget <= 0) {
    throw invalidPayload("payload chunk metadata exceeds the canonical line limit");
  }
  let offset = 0;
  let codeUnitsVisited = 0;
  while (offset < canonicalJson.length || fragments.length === 0) {
    const fragmentStart = offset;
    let escapedBytes = 0;
    while (offset < canonicalJson.length) {
      const measured = escapedJsonCodePointBytes(canonicalJson, offset);
      if (escapedBytes + measured.escapedBytes > escapedFragmentBudget) break;
      escapedBytes += measured.escapedBytes;
      offset += measured.codeUnits;
      codeUnitsVisited += measured.codeUnits;
    }
    if (fragmentStart === offset && offset < canonicalJson.length) {
      throw invalidPayload("payload fragment cannot fit the canonical line limit");
    }
    fragments.push(canonicalJson.slice(fragmentStart, offset));
    if (fragments.length > MAX_COMPACTION_PAYLOAD_CHUNKS) {
      throw invalidPayload("payload requires too many canonical chunks");
    }
  }
  return { fragments, codeUnitsVisited };
}

function escapedJsonCodePointBytes(
  value: string,
  offset: number,
): { readonly escapedBytes: number; readonly codeUnits: 1 | 2 } {
  const first = value.charCodeAt(offset);
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = value.charCodeAt(offset + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return { escapedBytes: 4, codeUnits: 2 };
    }
    return { escapedBytes: 6, codeUnits: 1 };
  }
  if (first >= 0xdc00 && first <= 0xdfff) {
    return { escapedBytes: 6, codeUnits: 1 };
  }
  if (first === 0x22 || first === 0x5c) {
    return { escapedBytes: 2, codeUnits: 1 };
  }
  if (
    first === 0x08 || first === 0x09 || first === 0x0a ||
    first === 0x0c || first === 0x0d
  ) {
    return { escapedBytes: 2, codeUnits: 1 };
  }
  if (first <= 0x1f) return { escapedBytes: 6, codeUnits: 1 };
  if (first <= 0x7f) return { escapedBytes: 1, codeUnits: 1 };
  if (first <= 0x7ff) return { escapedBytes: 2, codeUnits: 1 };
  return { escapedBytes: 3, codeUnits: 1 };
}

function compactionPayloadSha256(
  attemptId: string,
  payloadKind: CompactionPayloadKind,
  canonicalJson: string,
): string {
  return sha256Hex(
    `${COMPACTION_PAYLOAD_DIGEST_DOMAIN}${attemptId}\0${payloadKind}\0${canonicalJson}`,
  );
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
