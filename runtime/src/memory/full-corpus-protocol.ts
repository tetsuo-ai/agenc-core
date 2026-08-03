import { Buffer } from "node:buffer";

import {
  MAX_MEMORY_FTS_CANDIDATES,
  MAX_MEMORY_QUERY_RESULT_BYTES,
  type MemoryIndexRootRole,
  type MemoryRankCandidate,
} from "./full-corpus-contract.js";

export const MEMORY_QUERY_HELPER_PROTOCOL_VERSION = 1;
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

export type MemoryQueryHelperResponse =
  | {
      readonly protocolVersion: typeof MEMORY_QUERY_HELPER_PROTOCOL_VERSION;
      readonly kind: "ok";
      readonly candidates: readonly MemoryRankCandidate[];
    }
  | {
      readonly protocolVersion: typeof MEMORY_QUERY_HELPER_PROTOCOL_VERSION;
      readonly kind: "error";
      readonly code:
        | "capability_unavailable"
        | "invalid_request"
        | "query_failed"
        | "query_resource_limited";
      readonly message: string;
    };

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
    if (typeof parsed.code !== "string" || typeof parsed.message !== "string") {
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
    typeof value.canonicalPath === "string" &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    (typeof value.type === "string" || value.type === null) &&
    typeof value.mtimeMs === "number" &&
    Number.isFinite(value.mtimeMs) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    typeof value.fingerprint === "string" &&
    typeof value.rootId === "string" &&
    (value.rootRole === "global" || value.rootRole === "project") &&
    typeof value.bm25Score === "number" &&
    Number.isFinite(value.bm25Score)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
