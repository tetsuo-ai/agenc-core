import { createHash, timingSafeEqual, type Hash } from "node:crypto";

export const TOOL_RESULT_INTEGRITY_VERSION = 1 as const;
export const TOOL_RESULT_DIGEST_ALGORITHM = "sha256" as const;
export const TOOL_RESULT_DIGEST_PREFIX = `${TOOL_RESULT_DIGEST_ALGORITHM}:`;
export const MAX_TOOL_CALL_ID_UTF8_BYTES = 4_096;
export const MAX_TOOL_RESULT_SCOPE_ID_BYTES = 4_096;
export const MAX_CANONICAL_BODY_DEPTH = 64;
export const MAX_CANONICAL_BODY_NODES = 1_000_000;

const TOOL_RESULT_BODY_DIGEST_DOMAIN = "agenc.tool-result-body.v1";
const TOOL_RESULT_ID_DOMAIN = "agenc.tool-result-id.v1";
const MAX_SAFE_LOG_ID_CODE_POINTS = 96;
const SHA256_HEX_LENGTH = 64;
const LENGTH_PREFIX_BYTES = 8;
const SHA256_DIGEST_PATTERN = new RegExp(
  `^${TOOL_RESULT_DIGEST_PREFIX}[0-9a-f]{${SHA256_HEX_LENGTH}}$`,
);
const TOOL_RESULT_ID_PATTERN = /^tool-result:[0-9a-f]{64}$/;
const INTEGRITY_KEYS = Object.freeze([
  "algorithm",
  "original",
  "persisted",
  "resultId",
  "runId",
  "toolCallId",
  "version",
]);
const BODY_IDENTITY_KEYS = Object.freeze(["byteLength", "digest"]);
const PERSISTED_IDENTITY_KEYS = Object.freeze([
  "byteLength",
  "digest",
  "representation",
]);

const enum CanonicalTag {
  Null = 0x00,
  False = 0x01,
  True = 0x02,
  Number = 0x03,
  String = 0x04,
  Array = 0x05,
  Object = 0x06,
  ObjectKey = 0x07,
}

export type ToolResultRepresentation = "original" | "compacted" | "truncated";

export interface ToolResultBodyIdentity {
  readonly digest: string;
  /** UTF-8 bytes in the canonical scalar payload, excluding framing. */
  readonly byteLength: number;
}

export interface PersistedToolResultIdentity extends ToolResultBodyIdentity {
  readonly representation: ToolResultRepresentation;
}

/**
 * Integrity metadata that remains attached to a tool result while its body is
 * compacted or truncated. `original` is immutable; `persisted` authenticates
 * the representation currently stored in the rollout.
 */
export interface ToolResultIntegrity {
  readonly version: typeof TOOL_RESULT_INTEGRITY_VERSION;
  readonly algorithm: typeof TOOL_RESULT_DIGEST_ALGORITHM;
  readonly runId: string;
  readonly toolCallId: string;
  readonly resultId: string;
  readonly original: ToolResultBodyIdentity;
  readonly persisted: PersistedToolResultIdentity;
}

export type ToolResultIntegrityFailureCode =
  | "invalid_integrity_metadata"
  | "run_id_mismatch"
  | "tool_call_id_mismatch"
  | "result_id_mismatch"
  | "persisted_body_digest_mismatch"
  | "persisted_body_length_mismatch"
  | "original_representation_mismatch"
  | "unsupported_body_value";

export type ToolResultIntegrityDeferralCode =
  "canonical_body_depth_limit" | "canonical_body_node_limit";

export interface ToolResultIntegrityFailure {
  readonly kind: "integrity_failure";
  readonly code: ToolResultIntegrityFailureCode;
  readonly reason: string;
}

export interface ToolResultIntegrityDeferral {
  readonly kind: "operational_deferral";
  readonly code: ToolResultIntegrityDeferralCode;
  readonly reason: string;
}

export type ToolResultIntegrityVerification =
  | {
      readonly status: "valid";
      readonly integrity: ToolResultIntegrity;
      readonly bodyIdentity: ToolResultBodyIdentity;
    }
  | {
      readonly status: "invalid";
      readonly failure: ToolResultIntegrityFailure;
    }
  | {
      readonly status: "deferred";
      readonly failure: ToolResultIntegrityDeferral;
    };

export class ToolResultCanonicalizationError extends Error {
  constructor(
    readonly code:
      ToolResultIntegrityFailureCode | ToolResultIntegrityDeferralCode,
    readonly kind: "integrity_failure" | "operational_deferral",
    message: string,
  ) {
    super(message);
    this.name = "ToolResultCanonicalizationError";
  }
}

/**
 * Small streaming writer used by both body identities and checkpoint-v2
 * hashes. Every field is domain-separated and length-prefixed; callers never
 * need to materialize one giant JSON string solely to hash it.
 */
export class CanonicalSha256Writer {
  readonly #hash: Hash;
  #payloadByteLength = 0;

  constructor(domain: string) {
    this.#hash = createHash(TOOL_RESULT_DIGEST_ALGORITHM);
    this.writeString("domain", domain, false);
  }

  get payloadByteLength(): number {
    return this.#payloadByteLength;
  }

  writeTag(tag: number): void {
    const encoded = Buffer.allocUnsafe(1);
    encoded.writeUInt8(tag);
    this.#hash.update(encoded);
  }

  writeCount(label: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ToolResultCanonicalizationError(
        "unsupported_body_value",
        "integrity_failure",
        `${label} must be a non-negative safe integer`,
      );
    }
    this.writeString("count-label", label, false);
    this.#hash.update(encodeUnsignedLength(value));
  }

  writeString(label: string, value: string, countPayload = true): void {
    assertWellFormedUtf16(label, "canonical field label");
    assertWellFormedUtf16(value, label);
    const labelBytes = Buffer.from(label, "utf8");
    const valueByteLength = Buffer.byteLength(value, "utf8");
    this.#hash.update(encodeUnsignedLength(labelBytes.length));
    this.#hash.update(labelBytes);
    this.#hash.update(encodeUnsignedLength(valueByteLength));
    this.#hash.update(value, "utf8");
    if (countPayload) this.#payloadByteLength += valueByteLength;
  }

  digest(): string {
    return `${TOOL_RESULT_DIGEST_PREFIX}${this.#hash.digest("hex")}`;
  }
}

export function digestToolResultBody(
  content: unknown,
  limits: { readonly maxNodes?: number } = {},
): ToolResultBodyIdentity {
  const maxNodes = boundedCanonicalNodeLimit(limits.maxNodes);
  const writer = new CanonicalSha256Writer(TOOL_RESULT_BODY_DIGEST_DOMAIN);
  const activeObjects = new WeakSet<object>();
  const visited = { nodes: 0 };
  writeCanonicalValue(writer, content, 0, activeObjects, visited, maxNodes);
  return {
    digest: writer.digest(),
    byteLength: writer.payloadByteLength,
  };
}

export function deterministicToolResultId(
  runId: string,
  toolCallId: string,
): string {
  assertBoundedIdentity(runId, "runId", MAX_TOOL_RESULT_SCOPE_ID_BYTES);
  assertBoundedIdentity(toolCallId, "toolCallId", MAX_TOOL_CALL_ID_UTF8_BYTES);
  const writer = new CanonicalSha256Writer(TOOL_RESULT_ID_DOMAIN);
  writer.writeString("run-id", runId);
  writer.writeString("tool-call-id", toolCallId);
  return `tool-result:${writer.digest().slice(TOOL_RESULT_DIGEST_PREFIX.length)}`;
}

export function createToolResultIntegrity(params: {
  readonly runId: string;
  readonly toolCallId: string;
  readonly content: unknown;
}): ToolResultIntegrity {
  const resultId = deterministicToolResultId(params.runId, params.toolCallId);
  const original = digestToolResultBody(params.content);
  return {
    version: TOOL_RESULT_INTEGRITY_VERSION,
    algorithm: TOOL_RESULT_DIGEST_ALGORITHM,
    runId: params.runId,
    toolCallId: params.toolCallId,
    resultId,
    original,
    persisted: {
      representation: "original",
      ...original,
    },
  };
}

export function withPersistedToolResultRepresentation(
  integrity: ToolResultIntegrity,
  representation: Exclude<ToolResultRepresentation, "original">,
  content: unknown,
): ToolResultIntegrity {
  const persisted = digestToolResultBody(content);
  return {
    ...integrity,
    persisted: { representation, ...persisted },
  };
}

export function verifyToolResultIntegrity(params: {
  readonly integrity: unknown;
  /** Expected durable scope when the caller knows the owning run/session. */
  readonly expectedRunId?: string;
  readonly toolCallId: string;
  readonly content: unknown;
}): ToolResultIntegrityVerification {
  const parsed = parseToolResultIntegrity(params.integrity);
  if (parsed.status !== "valid") return parsed;
  const integrity = parsed.integrity;
  if (integrity.toolCallId !== params.toolCallId) {
    return invalid(
      "tool_call_id_mismatch",
      `tool result metadata identifies ${formatIdentityForLog(integrity.toolCallId)}, not ${formatIdentityForLog(params.toolCallId)}`,
    );
  }
  if (
    params.expectedRunId !== undefined &&
    integrity.runId !== params.expectedRunId
  ) {
    return invalid(
      "run_id_mismatch",
      `tool result ${formatIdentityForLog(params.toolCallId)} belongs to a different durable run`,
    );
  }
  const expectedResultId = deterministicToolResultId(
    integrity.runId,
    integrity.toolCallId,
  );
  if (!constantTimeDigestEqual(integrity.resultId, expectedResultId)) {
    return invalid(
      "result_id_mismatch",
      `tool result ${formatIdentityForLog(params.toolCallId)} has a non-canonical result identity`,
    );
  }

  let bodyIdentity: ToolResultBodyIdentity;
  try {
    bodyIdentity = digestToolResultBody(params.content);
  } catch (error) {
    return canonicalizationFailure(error);
  }
  if (
    !constantTimeDigestEqual(bodyIdentity.digest, integrity.persisted.digest)
  ) {
    return invalid(
      "persisted_body_digest_mismatch",
      `persisted body digest does not match tool result ${formatIdentityForLog(params.toolCallId)}`,
    );
  }
  if (bodyIdentity.byteLength !== integrity.persisted.byteLength) {
    return invalid(
      "persisted_body_length_mismatch",
      `persisted body length does not match tool result ${formatIdentityForLog(params.toolCallId)}`,
    );
  }
  if (
    integrity.persisted.representation === "original" &&
    (!constantTimeDigestEqual(
      integrity.original.digest,
      integrity.persisted.digest,
    ) ||
      integrity.original.byteLength !== integrity.persisted.byteLength)
  ) {
    return invalid(
      "original_representation_mismatch",
      `original representation identity is inconsistent for tool result ${formatIdentityForLog(params.toolCallId)}`,
    );
  }
  return { status: "valid", integrity, bodyIdentity };
}

export function constantTimeDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

export function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && SHA256_DIGEST_PATTERN.test(value);
}

export function formatIdentityForLog(value: string): string {
  let shortened = "";
  let count = 0;
  let truncated = false;
  for (const codePoint of value) {
    if (count === MAX_SAFE_LOG_ID_CODE_POINTS) {
      truncated = true;
      break;
    }
    shortened += codePoint;
    count += 1;
  }
  if (truncated) shortened += "…";
  return `${JSON.stringify(shortened)} (${Buffer.byteLength(value, "utf8")} UTF-8 bytes)`;
}

function parseToolResultIntegrity(
  value: unknown,
):
  | { readonly status: "valid"; readonly integrity: ToolResultIntegrity }
  | {
      readonly status: "invalid";
      readonly failure: ToolResultIntegrityFailure;
    } {
  if (!isRecord(value) || !hasExactKeys(value, INTEGRITY_KEYS)) {
    return invalid(
      "invalid_integrity_metadata",
      "tool result integrity metadata is missing",
    );
  }
  if (
    value.version !== TOOL_RESULT_INTEGRITY_VERSION ||
    value.algorithm !== TOOL_RESULT_DIGEST_ALGORITHM ||
    typeof value.runId !== "string" ||
    typeof value.toolCallId !== "string" ||
    typeof value.resultId !== "string" ||
    !TOOL_RESULT_ID_PATTERN.test(value.resultId) ||
    !isBodyIdentity(value.original) ||
    !isPersistedBodyIdentity(value.persisted)
  ) {
    return invalid(
      "invalid_integrity_metadata",
      "tool result integrity metadata has an unsupported or malformed shape",
    );
  }
  try {
    assertBoundedIdentity(value.runId, "runId", MAX_TOOL_RESULT_SCOPE_ID_BYTES);
    assertBoundedIdentity(
      value.toolCallId,
      "toolCallId",
      MAX_TOOL_CALL_ID_UTF8_BYTES,
    );
  } catch {
    return invalid(
      "invalid_integrity_metadata",
      "tool result integrity metadata contains an invalid identity",
    );
  }
  return {
    status: "valid",
    integrity: value as unknown as ToolResultIntegrity,
  };
}

function isBodyIdentity(value: unknown): value is ToolResultBodyIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, BODY_IDENTITY_KEYS) &&
    isSha256Digest(value.digest) &&
    Number.isSafeInteger(value.byteLength) &&
    (value.byteLength as number) >= 0
  );
}

function isPersistedBodyIdentity(
  value: unknown,
): value is PersistedToolResultIdentity {
  if (!isRecord(value) || !hasExactKeys(value, PERSISTED_IDENTITY_KEYS)) {
    return false;
  }
  if (
    !isSha256Digest(value.digest) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 0
  ) {
    return false;
  }
  const representation = value.representation;
  return (
    representation === "original" ||
    representation === "compacted" ||
    representation === "truncated"
  );
}

function writeCanonicalValue(
  writer: CanonicalSha256Writer,
  value: unknown,
  depth: number,
  activeObjects: WeakSet<object>,
  visited: { nodes: number },
  maxNodes: number,
): void {
  if (depth > MAX_CANONICAL_BODY_DEPTH) {
    throw new ToolResultCanonicalizationError(
      "canonical_body_depth_limit",
      "operational_deferral",
      `tool result canonicalization exceeds depth ${MAX_CANONICAL_BODY_DEPTH}`,
    );
  }
  visited.nodes += 1;
  if (visited.nodes > maxNodes) {
    throw new ToolResultCanonicalizationError(
      "canonical_body_node_limit",
      "operational_deferral",
      `tool result canonicalization exceeds ${maxNodes} values`,
    );
  }

  if (value === null) {
    writer.writeTag(CanonicalTag.Null);
    writer.writeString("null", "null");
    return;
  }
  if (typeof value === "boolean") {
    writer.writeTag(value ? CanonicalTag.True : CanonicalTag.False);
    writer.writeString("boolean", value ? "true" : "false");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ToolResultCanonicalizationError(
        "unsupported_body_value",
        "integrity_failure",
        "tool result body contains a non-finite number",
      );
    }
    writer.writeTag(CanonicalTag.Number);
    writer.writeString("number", JSON.stringify(value));
    return;
  }
  if (typeof value === "string") {
    writer.writeTag(CanonicalTag.String);
    writer.writeString("string", value);
    return;
  }
  if (typeof value !== "object") {
    throw new ToolResultCanonicalizationError(
      "unsupported_body_value",
      "integrity_failure",
      `tool result body contains unsupported ${typeof value} content`,
    );
  }
  if (activeObjects.has(value)) {
    throw new ToolResultCanonicalizationError(
      "unsupported_body_value",
      "integrity_failure",
      "tool result body contains a cyclic value",
    );
  }
  activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      writer.writeTag(CanonicalTag.Array);
      writer.writeCount("array-length", value.length);
      for (const element of value) {
        writeCanonicalValue(
          writer,
          element === undefined ? null : element,
          depth + 1,
          activeObjects,
          visited,
          maxNodes,
        );
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ToolResultCanonicalizationError(
        "unsupported_body_value",
        "integrity_failure",
        "tool result body must contain only JSON-compatible plain objects",
      );
    }
    const record = value as Record<string, unknown>;
    assertEnumerableOwnKeyBudget(record, maxNodes - visited.nodes);
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    writer.writeTag(CanonicalTag.Object);
    writer.writeCount("object-key-count", keys.length);
    for (const key of keys) {
      writer.writeTag(CanonicalTag.ObjectKey);
      writer.writeString("object-key", key);
      writeCanonicalValue(
        writer,
        record[key],
        depth + 1,
        activeObjects,
        visited,
        maxNodes,
      );
    }
  } finally {
    activeObjects.delete(value);
  }
}

function encodeUnsignedLength(value: number): Buffer {
  const encoded = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

function assertBoundedIdentity(
  value: string,
  field: string,
  maxBytes: number,
): void {
  assertWellFormedUtf16(value, field);
  const byteLength = Buffer.byteLength(value, "utf8");
  if (value.length === 0 || value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  if (byteLength > maxBytes) {
    throw new Error(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  }
}

function assertWellFormedUtf16(value: string, field: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      throw illFormedString(field);
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw illFormedString(field);
    }
  }
}

function illFormedString(field: string): ToolResultCanonicalizationError {
  return new ToolResultCanonicalizationError(
    "unsupported_body_value",
    "integrity_failure",
    `${field} must contain well-formed UTF-16`,
  );
}

function boundedCanonicalNodeLimit(value: number | undefined): number {
  if (value === undefined) return MAX_CANONICAL_BODY_NODES;
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_CANONICAL_BODY_NODES
  ) {
    throw new Error(
      `maxNodes must be a positive safe integer no greater than ${MAX_CANONICAL_BODY_NODES}`,
    );
  }
  return value;
}

function assertEnumerableOwnKeyBudget(
  value: Record<string, unknown>,
  remainingNodes: number,
): void {
  let keyCount = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    keyCount += 1;
    if (keyCount > remainingNodes) {
      throw new ToolResultCanonicalizationError(
        "canonical_body_node_limit",
        "operational_deferral",
        "tool result canonicalization exceeds the remaining object-key budget",
      );
    }
  }
}

function canonicalizationFailure(
  error: unknown,
): ToolResultIntegrityVerification {
  if (error instanceof ToolResultCanonicalizationError) {
    if (error.kind === "operational_deferral") {
      return {
        status: "deferred",
        failure: {
          kind: error.kind,
          code: error.code as ToolResultIntegrityDeferralCode,
          reason: error.message,
        },
      };
    }
    return invalid(error.code as ToolResultIntegrityFailureCode, error.message);
  }
  throw error;
}

function invalid(
  code: ToolResultIntegrityFailureCode,
  reason: string,
): {
  readonly status: "invalid";
  readonly failure: ToolResultIntegrityFailure;
} {
  return {
    status: "invalid",
    failure: { kind: "integrity_failure", code, reason },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
