import { Buffer } from "node:buffer";

import type { MemoryHeader } from "./scan.js";

export const MAX_C3A_SCAN_FILES = 200;
export const MAX_C3A_ROOTS = 2;
export const MAX_C3A_ROOT_PATH_UTF8_BYTES = 16_384;
export const MAX_C3A_TRAVERSAL_ENTRIES = 100_000;
export const MAX_C3A_CANDIDATE_FILES = 10_000;
export const MAX_C3A_SCAN_MS = 1_000;
export const MAX_C3A_PATH_UTF8_BYTES = 16_384;
export const MAX_C3A_TOTAL_PATH_UTF8_BYTES = 16_777_216;
export const MAX_C3A_HEADER_BYTES_PER_FILE = 65_536;
export const MAX_C3A_TOTAL_HEADER_BYTES = 4_194_304;
export const MAX_C3A_QUERY_CODEPOINTS = 1_024;
export const MAX_C3A_QUERY_TERMS = 128;
export const MAX_C3A_TERM_OCCURRENCES_PER_TERM = 8;
export const MAX_MEMORY_SELECTOR_CANDIDATES = 50;
export const MAX_MEMORY_SELECTOR_EXTRACT_UTF8_BYTES_PER_CANDIDATE = 4_096;
export const MAX_MEMORY_SELECTOR_TOTAL_UTF8_BYTES = 262_144;
export const MAX_MEMORY_SELECTOR_INPUT_TOKENS = 32_768;
export const MAX_MEMORY_SELECTOR_OUTPUT_TOKENS = 1_024;
export const MAX_MEMORY_SELECTOR_OUTPUT_UTF8_BYTES = 65_536;
export const MAX_MEMORY_SELECTOR_MS = 5_000;
export const MAX_RELEVANT_MEMORIES = 5;

const MAX_RECENT_TOOLS = 32;
const MAX_RECENT_TOOL_UTF8_BYTES = 256;
const UNICODE_TOKEN = /[\p{L}\p{N}]+/gu;

export type MemoryRecallMode = "query" | "session_start";

export interface NormalizedMemoryQuery {
  readonly phrase: string;
  readonly terms: readonly string[];
  readonly truncated: boolean;
}

export interface RankedMemoryHeader {
  readonly header: MemoryHeader;
  readonly exactPhrase: boolean;
  readonly distinctTermCoverage: number;
  readonly cappedTermOccurrences: number;
}

export interface MemorySelectorCandidate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly type: string | null;
  readonly mtimeMs: number;
  readonly omitted: {
    readonly titleUtf8Bytes: number;
    readonly descriptionUtf8Bytes: number;
  };
}

export interface MemorySelectorRequest {
  readonly policy: "agenc.memory-selector.v1";
  readonly query: {
    readonly text: string;
    readonly mode: MemoryRecallMode;
  };
  readonly recentTools: readonly string[];
  readonly candidates: readonly MemorySelectorCandidate[];
}

export type AdmittedMemorySelectorResult =
  | {
      readonly kind: "selected";
      readonly candidateIds: readonly string[];
    }
  | {
      readonly kind: "unavailable" | "timeout" | "malformed";
    };

export interface AdmittedMemorySelector {
  select(
    request: MemorySelectorRequest,
    signal: AbortSignal,
  ): Promise<AdmittedMemorySelectorResult>;
}

export function throwIfMemoryRecallAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw (
    signal.reason ?? new DOMException("Memory recall aborted", "AbortError")
  );
}

export function isMemoryRecallAbort(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted === true) return true;
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export function normalizeMemoryText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replaceAll("ς", "σ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeMemoryQuery(query: string): NormalizedMemoryQuery {
  let bounded = "";
  let codepoints = 0;
  let truncated = false;
  for (const codepoint of query) {
    if (codepoints >= MAX_C3A_QUERY_CODEPOINTS) {
      truncated = true;
      break;
    }
    bounded += codepoint;
    codepoints += 1;
  }
  const phrase = normalizeMemoryText(bounded);
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of phrase.matchAll(UNICODE_TOKEN)) {
    const term = match[0];
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_C3A_QUERY_TERMS) break;
  }
  return Object.freeze({
    phrase,
    terms: Object.freeze(terms),
    truncated,
  });
}

export function rankMemoryHeaders(
  query: NormalizedMemoryQuery,
  headers: readonly MemoryHeader[],
  mode: MemoryRecallMode,
  signal: AbortSignal,
): RankedMemoryHeader[] {
  if (mode === "query" && query.terms.length === 0) return [];
  const queryTerms = new Set(query.terms);
  const ranked: RankedMemoryHeader[] = [];

  for (const header of headers) {
    throwIfMemoryRecallAborted(signal);
    const haystack = normalizeMemoryText(
      `${header.title}\n${header.description ?? ""}`,
    );
    const counts = new Map<string, number>();
    for (const match of haystack.matchAll(UNICODE_TOKEN)) {
      const term = match[0];
      if (!queryTerms.has(term)) continue;
      const count = counts.get(term) ?? 0;
      if (count < MAX_C3A_TERM_OCCURRENCES_PER_TERM) {
        counts.set(term, count + 1);
      }
    }
    const exactPhrase =
      query.phrase.length > 0 && haystack.includes(query.phrase);
    const distinctTermCoverage = counts.size;
    if (mode === "query" && !exactPhrase && distinctTermCoverage === 0) {
      continue;
    }
    let cappedTermOccurrences = 0;
    for (const count of counts.values()) cappedTermOccurrences += count;
    ranked.push({
      header,
      exactPhrase,
      distinctTermCoverage,
      cappedTermOccurrences,
    });
  }

  ranked.sort(compareRankedMemoryHeaders);
  return ranked;
}

function compareRankedMemoryHeaders(
  left: RankedMemoryHeader,
  right: RankedMemoryHeader,
): number {
  if (left.exactPhrase !== right.exactPhrase) {
    return left.exactPhrase ? -1 : 1;
  }
  if (left.distinctTermCoverage !== right.distinctTermCoverage) {
    return right.distinctTermCoverage - left.distinctTermCoverage;
  }
  if (left.cappedTermOccurrences !== right.cappedTermOccurrences) {
    return right.cappedTermOccurrences - left.cappedTermOccurrences;
  }
  if (left.header.mtimeMs !== right.header.mtimeMs) {
    return right.header.mtimeMs - left.header.mtimeMs;
  }
  return Buffer.compare(left.header.pathBytes, right.header.pathBytes);
}

export function buildMemorySelectorRequest(
  query: string,
  mode: MemoryRecallMode,
  ranked: readonly RankedMemoryHeader[],
  recentTools: readonly string[],
): MemorySelectorRequest {
  const candidates: Array<{
    id: string;
    title: string;
    description: string;
    type: string | null;
    mtimeMs: number;
    omitted: { titleUtf8Bytes: number; descriptionUtf8Bytes: number };
  }> = ranked.slice(0, MAX_MEMORY_SELECTOR_CANDIDATES).map((entry, index) => ({
    id: `candidate-${index + 1}`,
    title: "",
    description: "",
    type: entry.header.type ?? null,
    mtimeMs: entry.header.mtimeMs,
    omitted: {
      titleUtf8Bytes: Buffer.byteLength(entry.header.title, "utf8"),
      descriptionUtf8Bytes: Buffer.byteLength(
        entry.header.description ?? "",
        "utf8",
      ),
    },
  }));
  const request = {
    policy: "agenc.memory-selector.v1" as const,
    query: { text: normalizeMemoryQuery(query).phrase, mode },
    recentTools: recentTools
      .slice(0, MAX_RECENT_TOOLS)
      .map((tool) => truncateUtf8(tool, MAX_RECENT_TOOL_UTF8_BYTES).text),
    candidates,
  };

  let serializedBytes = selectorRequestBytes(request);
  if (serializedBytes > MAX_MEMORY_SELECTOR_TOTAL_UTF8_BYTES) {
    throw new Error("memory selector base request exceeds its byte limit");
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const source = ranked[index]!.header;
    let remainingCandidateBytes =
      MAX_MEMORY_SELECTOR_EXTRACT_UTF8_BYTES_PER_CANDIDATE;
    const title = fitSelectorField(
      source.title,
      remainingCandidateBytes,
      MAX_MEMORY_SELECTOR_TOTAL_UTF8_BYTES - serializedBytes,
    );
    candidate.title = title.text;
    candidate.omitted.titleUtf8Bytes = title.omittedUtf8Bytes;
    remainingCandidateBytes -= title.utf8Bytes;
    serializedBytes += title.serializedDeltaBytes;

    const description = fitSelectorField(
      source.description ?? "",
      remainingCandidateBytes,
      MAX_MEMORY_SELECTOR_TOTAL_UTF8_BYTES - serializedBytes,
    );
    candidate.description = description.text;
    candidate.omitted.descriptionUtf8Bytes = description.omittedUtf8Bytes;
    serializedBytes += description.serializedDeltaBytes;
  }
  const finalBytes = selectorRequestBytes(request);
  if (finalBytes > MAX_MEMORY_SELECTOR_TOTAL_UTF8_BYTES) {
    throw new Error("memory selector request byte accounting drifted");
  }
  return Object.freeze({
    ...request,
    recentTools: Object.freeze(request.recentTools),
    candidates: Object.freeze(
      candidates.map((candidate) =>
        Object.freeze({
          ...candidate,
          omitted: Object.freeze({ ...candidate.omitted }),
        }),
      ),
    ),
  });
}

interface FittedSelectorField {
  readonly text: string;
  readonly utf8Bytes: number;
  readonly omittedUtf8Bytes: number;
  readonly serializedDeltaBytes: number;
}

function fitSelectorField(
  value: string,
  rawByteLimit: number,
  serializedByteLimit: number,
): FittedSelectorField {
  let text = "";
  let utf8Bytes = 0;
  let serializedDeltaBytes = 0;
  const sourceBytes = Buffer.byteLength(value, "utf8");
  for (const codepoint of value) {
    const codepointBytes = Buffer.byteLength(codepoint, "utf8");
    const encodedBytes =
      Buffer.byteLength(JSON.stringify(codepoint), "utf8") - 2;
    if (
      utf8Bytes + codepointBytes > rawByteLimit ||
      serializedDeltaBytes + encodedBytes > serializedByteLimit
    ) {
      break;
    }
    text += codepoint;
    utf8Bytes += codepointBytes;
    serializedDeltaBytes += encodedBytes;
  }
  return {
    text,
    utf8Bytes,
    omittedUtf8Bytes: sourceBytes - utf8Bytes,
    serializedDeltaBytes,
  };
}

function selectorRequestBytes(request: object): number {
  return Buffer.byteLength(JSON.stringify(request), "utf8");
}

function truncateUtf8(
  value: string,
  maximumBytes: number,
): { readonly text: string; readonly omittedUtf8Bytes: number } {
  let text = "";
  let bytes = 0;
  for (const codepoint of value) {
    const next = Buffer.byteLength(codepoint, "utf8");
    if (bytes + next > maximumBytes) break;
    text += codepoint;
    bytes += next;
  }
  return {
    text,
    omittedUtf8Bytes: Buffer.byteLength(value, "utf8") - bytes,
  };
}
