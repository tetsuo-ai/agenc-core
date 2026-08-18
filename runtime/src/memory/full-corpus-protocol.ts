import { Buffer } from "node:buffer";
import { dirname, isAbsolute, join, sep } from "node:path";

import {
  MAX_MEMORY_FTS_CANDIDATES,
  MAX_MEMORY_PATH_UTF8_BYTES,
  MAX_MEMORY_QUERY_RESULT_BYTES,
  memoryIndexRootId,
  stableMemoryId,
  type MemoryIndexRootRole,
  type MemoryRankCandidate,
} from "./full-corpus-contract.js";

export const MEMORY_QUERY_HELPER_PROTOCOL_VERSION = 2;
export const MEMORY_QUERY_FRAME_HEADER_BYTES = 4;
export const MAX_MEMORY_QUERY_REQUEST_BYTES = 1_048_576;

export interface MemoryQueryHelperRequest {
  readonly protocolVersion: typeof MEMORY_QUERY_HELPER_PROTOCOL_VERSION;
  readonly databasePath: string;
  readonly rootId: string;
  readonly generationId: number;
  readonly rootRole: MemoryIndexRootRole;
  readonly match: string;
  readonly limit: number;
}

export type MemoryQueryHelperErrorCode =
  | "capability_unavailable"
  | "invalid_request"
  | "query_failed"
  | "query_resource_limited";

export type MemoryQueryHelperResponse =
  | {
      readonly protocolVersion: typeof MEMORY_QUERY_HELPER_PROTOCOL_VERSION;
      readonly kind: "ok";
      readonly candidates: readonly MemoryRankCandidate[];
    }
  | {
      readonly protocolVersion: typeof MEMORY_QUERY_HELPER_PROTOCOL_VERSION;
      readonly kind: "error";
      readonly code: MemoryQueryHelperErrorCode;
      readonly message: string;
    };

const MEMORY_QUERY_HELPER_ERROR_CODES: ReadonlySet<MemoryQueryHelperErrorCode> =
  new Set([
    "capability_unavailable",
    "invalid_request",
    "query_failed",
    "query_resource_limited",
  ]);

export function encodeMemoryQueryFrame(value: object): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength > MAX_MEMORY_QUERY_REQUEST_BYTES) {
    throw new RangeError("memory query request frame exceeds its byte limit");
  }
  const frame = Buffer.allocUnsafe(
    MEMORY_QUERY_FRAME_HEADER_BYTES + payload.byteLength,
  );
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, MEMORY_QUERY_FRAME_HEADER_BYTES);
  return frame;
}

export function decodeMemoryQueryResponseFrame(
  frame: Uint8Array,
): MemoryQueryHelperResponse {
  if (
    frame.byteLength < MEMORY_QUERY_FRAME_HEADER_BYTES ||
    frame.byteLength >
      MEMORY_QUERY_FRAME_HEADER_BYTES + MAX_MEMORY_QUERY_RESULT_BYTES
  ) {
    throw new Error("memory query response frame has invalid length");
  }
  const bytes = Buffer.from(frame);
  const payloadLength = bytes.readUInt32BE(0);
  if (
    payloadLength !== bytes.byteLength - MEMORY_QUERY_FRAME_HEADER_BYTES ||
    payloadLength > MAX_MEMORY_QUERY_RESULT_BYTES
  ) {
    throw new Error(
      "memory query response frame length does not match payload",
    );
  }
  const parsed = JSON.parse(
    bytes.subarray(MEMORY_QUERY_FRAME_HEADER_BYTES).toString("utf8"),
  ) as unknown;
  if (!isRecord(parsed))
    throw new Error("memory query response is not an object");
  if (parsed.protocolVersion !== MEMORY_QUERY_HELPER_PROTOCOL_VERSION) {
    throw new Error("memory query response protocol version is incompatible");
  }
  if (parsed.kind === "error") {
    if (
      !isMemoryQueryHelperErrorCode(parsed.code) ||
      typeof parsed.message !== "string"
    ) {
      throw new Error("memory query error response is malformed");
    }
    return parsed as MemoryQueryHelperResponse;
  }
  if (parsed.kind !== "ok" || !Array.isArray(parsed.candidates)) {
    throw new Error("memory query success response is malformed");
  }
  if (parsed.candidates.length > MAX_MEMORY_FTS_CANDIDATES) {
    throw new Error("memory query response candidate count exceeds limit");
  }
  for (const candidate of parsed.candidates) {
    if (!isMemoryRankCandidate(candidate)) {
      throw new Error("memory query response contains a malformed candidate");
    }
  }
  return parsed as unknown as MemoryQueryHelperResponse;
}

function isMemoryRankCandidate(value: unknown): value is MemoryRankCandidate {
  if (!isRecord(value)) return false;
  return (
    typeof value.memoryId === "string" &&
    /^[0-9a-f]{64}$/u.test(value.memoryId) &&
    Number.isSafeInteger(value.generationId) &&
    (value.generationId as number) > 0 &&
    typeof value.canonicalPath === "string" &&
    isAbsolute(value.canonicalPath) &&
    value.canonicalPath === value.canonicalPath.normalize("NFC") &&
    stableMemoryId(value.canonicalPath) === value.memoryId &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    (typeof value.type === "string" || value.type === null) &&
    typeof value.mtimeMs === "number" &&
    Number.isFinite(value.mtimeMs) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    typeof value.fingerprint === "string" &&
    /^[0-9a-f]{64}$/u.test(value.fingerprint) &&
    typeof value.rootId === "string" &&
    /^[0-9a-f]{64}$/u.test(value.rootId) &&
    (value.rootRole === "global" || value.rootRole === "project") &&
    isHeaderSnapshot(
      value.headerSnapshot,
      value.canonicalPath,
      value.rootId,
    ) &&
    typeof value.bm25Score === "number" &&
    Number.isFinite(value.bm25Score)
  );
}

function isHeaderSnapshot(
  value: unknown,
  canonicalPath: string,
  rootId: string,
): boolean {
  if (!isRecord(value)) return false;
  const rootPath = candidateRootPath(canonicalPath, value.relativePath);
  return (
    rootPath !== null &&
    memoryIndexRootId(rootPath) === rootId &&
    isNonNegativeIntegerString(value.fileDev) &&
    isNonNegativeIntegerString(value.fileIno) &&
    isNonNegativeIntegerString(value.fileMode) &&
    isNonNegativeIntegerString(value.fileMtimeNs) &&
    isNonNegativeIntegerString(value.fileCtimeNs) &&
    isNonNegativeIntegerString(value.rootDev) &&
    isNonNegativeIntegerString(value.rootIno) &&
    isNonNegativeIntegerString(value.rootMode) &&
    isNonNegativeIntegerString(value.rootSize) &&
    isNonNegativeIntegerString(value.rootMtimeNs) &&
    isNonNegativeIntegerString(value.rootCtimeNs)
  );
}

function candidateRootPath(
  canonicalPath: string,
  relativePath: unknown,
): string | null {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    Buffer.byteLength(relativePath, "utf8") > MAX_MEMORY_PATH_UTF8_BYTES
  ) {
    return null;
  }
  const segments = platformRelativePathSegments(relativePath);
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  let rootPath = canonicalPath;
  for (const _segment of segments) rootPath = dirname(rootPath);
  if (
    !isAbsolute(rootPath) ||
    Buffer.byteLength(rootPath, "utf8") > MAX_MEMORY_PATH_UTF8_BYTES ||
    join(rootPath, ...segments).normalize("NFC") !== canonicalPath
  ) {
    return null;
  }
  return rootPath;
}

function platformRelativePathSegments(relativePath: string): string[] {
  return sep === "\\"
    ? relativePath.split(/[/\\]/u)
    : relativePath.split("/");
}

function isMemoryQueryHelperErrorCode(
  value: unknown,
): value is MemoryQueryHelperErrorCode {
  return (
    typeof value === "string" &&
    MEMORY_QUERY_HELPER_ERROR_CODES.has(value as MemoryQueryHelperErrorCode)
  );
}

function isNonNegativeIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
