import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const MEMORY_INDEX_SCHEMA_VERSION = 1;
export const MEMORY_INDEX_POLICY_ID = "agenc-memory-index-v1";
export const MEMORY_INDEX_DIRECTORY = "derived-indexes";
export const MEMORY_INDEX_FILENAME = "memory-v1.sqlite";

export const MAX_MEMORY_INDEX_ROOTS = 64;
export const MAX_MEMORY_FILES_PER_ROOT = 1_000_000;
export const MAX_MEMORY_HEADER_UTF8_BYTES = 65_536;
export const MAX_MEMORY_PATH_UTF8_BYTES = 16_384;
export const MAX_MEMORY_RECENT_UNION = 32;
export const MAX_MEMORY_FTS_CANDIDATES = 200;
export { MAX_MEMORY_SELECTOR_CANDIDATES } from "./recall-contract.js";
export const MAX_MEMORY_INDEX_BUILD_ENTRIES_PER_SLICE = 10_000;
export const MAX_MEMORY_INDEX_BUILD_SLICE_MS = 30_000;
export const MAX_MEMORY_INDEX_TOTAL_BUILD_MS = 3_600_000;
export const MAX_MEMORY_EXPLICIT_REFRESH_WAIT_MS = 300_000;
export const MAX_MEMORY_QUERY_TERMS = 128;
export const MAX_MEMORY_QUERY_MS = 500;
export const MAX_MEMORY_QUERY_RESULT_BYTES = 1_048_576;
export const MAX_MEMORY_QUERY_PROCESSES = 4;
export const MAX_MEMORY_QUERY_QUEUE = 64;
export const MAX_MEMORY_INDEX_BYTES = 536_870_912;
export const MAX_MEMORY_INDEX_WATCHERS = 64;
export const MAX_MEMORY_INDEX_CONCURRENT_BUILDS = 2;
export const MAX_MEMORY_INDEX_CHANGE_LOG_EVENTS = 100_000;
export const MEMORY_INDEX_ROOT_IDLE_TTL_MS = 2_592_000_000;
export const MAX_MEMORY_INDEX_CLEANUP_ROOTS_PER_BATCH = 64;
export const MAX_MEMORY_INDEX_CLEANUP_MS_PER_SLICE = 1_000;
export const MEMORY_WATCH_DEBOUNCE_MS = 100;
export const MAX_MEMORY_AUDIT_ENTRIES_PER_SLICE = 10_000;
export const MAX_MEMORY_AUDIT_MS_PER_SLICE = 50;
export const MAX_MEMORY_BUILD_OPEN_DIRECTORIES = 32;
export const MEMORY_INDEX_BUILD_LEASE_MS = 60_000;
export const MEMORY_AUDIT_MIN_INTERVAL_MS = 60_000;
export const MEMORY_AUDIT_MAX_INTERVAL_MS = 86_400_000;
export const MEMORY_AUDIT_BACKOFF_MULTIPLIER = 100;

export const MEMORY_FTS_TOKENIZER = "unicode61 remove_diacritics 2";
export const MEMORY_FTS_TERM_OPERATOR = "OR";
export const MEMORY_BM25_TITLE_WEIGHT = 5.0;
export const MEMORY_BM25_DESCRIPTION_WEIGHT = 2.0;

export const MEMORY_RRF_K = 60;
export const MEMORY_RRF_PROJECT_WEIGHT = 1.25;
export const MEMORY_RRF_GLOBAL_WEIGHT = 1.0;
export const MEMORY_RRF_RECENT_WEIGHT = 0.25;

const MEMORY_FINGERPRINT_DOMAIN = Buffer.from(
  `${MEMORY_INDEX_POLICY_ID}:header-fingerprint\0`,
  "utf8",
);
const MEMORY_ID_DOMAIN = Buffer.from(
  `${MEMORY_INDEX_POLICY_ID}:stable-memory-id\0`,
  "utf8",
);
const MEMORY_ROOT_ID_DOMAIN = Buffer.from(
  `${MEMORY_INDEX_POLICY_ID}:canonical-root-id\0`,
  "utf8",
);
const LENGTH_PREFIX_BYTES = 8;

export type MemoryIndexRootRole = "global" | "project";

export interface MemoryFingerprintMetadata {
  readonly title: string;
  readonly description: string;
  readonly type: string | null;
}

export interface MemoryRankCandidate {
  readonly memoryId: string;
  readonly canonicalPath: string;
  readonly title: string;
  readonly description: string;
  readonly type: string | null;
  readonly mtimeMs: number;
  readonly size: number;
  readonly fingerprint: string;
  readonly rootId: string;
  readonly rootRole: MemoryIndexRootRole;
  readonly bm25Score?: number;
}

export interface MemoryFusedCandidate extends MemoryRankCandidate {
  readonly fusedScore: number;
  readonly projectPresent: boolean;
  readonly bestRank: number;
}

export class MemoryIndexBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryIndexBoundaryError";
  }
}

export class MemoryIndexQueryResourceLimitedError extends Error {
  readonly code = "query_resource_limited" as const;

  constructor(message: string) {
    super(message);
    this.name = "MemoryIndexQueryResourceLimitedError";
  }
}

export function memoryIndexRootId(canonicalRoot: string): string {
  return domainSeparatedDigest(MEMORY_ROOT_ID_DOMAIN, [
    Buffer.from(canonicalRoot.normalize("NFC"), "utf8"),
  ]);
}

export function stableMemoryId(canonicalPath: string): string {
  return domainSeparatedDigest(MEMORY_ID_DOMAIN, [
    Buffer.from(canonicalPath.normalize("NFC"), "utf8"),
  ]);
}

export function computeMemoryHeaderFingerprint(
  boundedHeaderBytes: Uint8Array,
  metadata: MemoryFingerprintMetadata,
): string {
  if (boundedHeaderBytes.byteLength > MAX_MEMORY_HEADER_UTF8_BYTES) {
    throw new MemoryIndexBoundaryError("memory header exceeds its byte limit");
  }
  const normalizedMetadata = Buffer.from(
    JSON.stringify({
      schemaVersion: MEMORY_INDEX_SCHEMA_VERSION,
      title: normalizeSearchableMetadata(metadata.title),
      description: normalizeSearchableMetadata(metadata.description),
      type:
        metadata.type === null
          ? null
          : normalizeSearchableMetadata(metadata.type),
    }),
    "utf8",
  );
  return domainSeparatedDigest(MEMORY_FINGERPRINT_DOMAIN, [
    Buffer.from(boundedHeaderBytes),
    normalizedMetadata,
  ]);
}

export function normalizeSearchableMetadata(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replaceAll("ς", "σ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function buildMemoryFtsMatch(terms: readonly string[]): string {
  if (terms.length > MAX_MEMORY_QUERY_TERMS) {
    throw new MemoryIndexBoundaryError("memory query term count exceeds limit");
  }
  return terms
    .map((term) => normalizeSearchableMetadata(term))
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(` ${MEMORY_FTS_TERM_OPERATOR} `);
}

export function fuseMemoryRanks(input: {
  readonly project: readonly MemoryRankCandidate[];
  readonly global: readonly MemoryRankCandidate[];
  readonly recent: readonly MemoryRankCandidate[];
}): MemoryFusedCandidate[] {
  const fused = new Map<
    string,
    {
      candidate: MemoryRankCandidate;
      score: number;
      projectPresent: boolean;
      bestRank: number;
    }
  >();
  addRankedList(fused, input.project, MEMORY_RRF_PROJECT_WEIGHT, true, true);
  addRankedList(fused, input.global, MEMORY_RRF_GLOBAL_WEIGHT, false, true);
  addRankedList(
    fused,
    input.recent.slice(0, MAX_MEMORY_RECENT_UNION),
    MEMORY_RRF_RECENT_WEIGHT,
    false,
    false,
  );
  return [...fused.values()]
    .map(({ candidate, score, projectPresent, bestRank }) => ({
      ...candidate,
      fusedScore: score,
      projectPresent,
      bestRank,
    }))
    .sort(compareFusedCandidates);
}

function addRankedList(
  fused: Map<
    string,
    {
      candidate: MemoryRankCandidate;
      score: number;
      projectPresent: boolean;
      bestRank: number;
    }
  >,
  candidates: readonly MemoryRankCandidate[],
  weight: number,
  projectList: boolean,
  allowNewCandidates: boolean,
): void {
  const seen = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const identity = canonicalCandidateIdentity(candidate);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const rank = index + 1;
    const prior = fused.get(identity);
    if (prior === undefined) {
      if (!allowNewCandidates) continue;
      fused.set(identity, {
        candidate,
        score: weight / (MEMORY_RRF_K + rank),
        projectPresent: projectList,
        bestRank: rank,
      });
      continue;
    }
    prior.score += weight / (MEMORY_RRF_K + rank);
    prior.projectPresent ||= projectList;
    prior.bestRank = Math.min(prior.bestRank, rank);
    if (projectList && prior.candidate.rootRole !== "project") {
      prior.candidate = candidate;
    }
  }
}

function canonicalCandidateIdentity(candidate: MemoryRankCandidate): string {
  return Buffer.from(candidate.canonicalPath.normalize("NFC"), "utf8").toString(
    "base64",
  );
}

function compareFusedCandidates(
  left: MemoryFusedCandidate,
  right: MemoryFusedCandidate,
): number {
  if (left.fusedScore !== right.fusedScore) {
    return right.fusedScore - left.fusedScore;
  }
  if (left.projectPresent !== right.projectPresent) {
    return left.projectPresent ? -1 : 1;
  }
  if (left.bestRank !== right.bestRank) return left.bestRank - right.bestRank;
  const pathOrder = Buffer.compare(
    Buffer.from(left.canonicalPath, "utf8"),
    Buffer.from(right.canonicalPath, "utf8"),
  );
  if (pathOrder !== 0) return pathOrder;
  return Buffer.compare(
    Buffer.from(left.memoryId, "utf8"),
    Buffer.from(right.memoryId, "utf8"),
  );
}

function domainSeparatedDigest(
  domain: Buffer,
  fields: readonly Buffer[],
): string {
  const hash = createHash("sha256");
  hash.update(domain);
  for (const field of fields) {
    const length = Buffer.alloc(LENGTH_PREFIX_BYTES);
    length.writeBigUInt64BE(BigInt(field.byteLength));
    hash.update(length);
    hash.update(field);
  }
  return hash.digest("hex");
}
