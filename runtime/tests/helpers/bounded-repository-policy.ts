import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  BoundedRepositoryError,
  invalidRepositoryInput,
  repositoryQuotaError,
  type BoundedRepositoryByteWrite,
  type BoundedRepositoryLimits,
  type BoundedRepositoryTestHooks,
  type MutableRepositoryUsage,
} from "./bounded-repository-types.js";
import {
  DEFAULT_PORTABLE_REPOSITORY_PATH_LIMITS,
  isWellFormedUnicode,
  portablePathIdentity,
  type PortableRepositoryPathLimits,
  validatePortableRepositoryPath,
} from "./portable-repository-path.js";

const BYTES_PER_MEBIBYTE = 1_048_576;
const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_MAX_TOTAL_BYTES = 16 * BYTES_PER_MEBIBYTE;
const DEFAULT_MAX_FILE_BYTES = BYTES_PER_MEBIBYTE;
const DEFAULT_GIT_OUTPUT_BYTES = 262_144;
const DEFAULT_GIT_WALL_MS = 10_000;

export const MAX_GIT_ARGUMENT_COUNT = 1_000;
export const MAX_GIT_ARGUMENT_BYTES = BYTES_PER_MEBIBYTE;
export const MAX_GIT_COMMIT_COUNT = 32;
export const MAX_GIT_MESSAGE_BYTES = 4_096;

export const MAX_CONFIGURED_ENTRIES = 100_000;
export const MAX_CONFIGURED_TOTAL_BYTES = 256 * BYTES_PER_MEBIBYTE;
export const MAX_CONFIGURED_FILE_BYTES = 64 * BYTES_PER_MEBIBYTE;
export const MAX_CONFIGURED_GIT_OUTPUT_BYTES = 16 * BYTES_PER_MEBIBYTE;
export const MAX_CONFIGURED_GIT_WALL_MS = 60_000;

export const REPOSITORY_LIMIT_KEYS = Object.freeze([
  "maxEntries",
  "maxTotalBytes",
  "maxFileBytes",
  "maxDepth",
  "maxPathUtf8Bytes",
  "maxSegmentUtf8Bytes",
  "maxSegmentUtf16CodeUnits",
  "maxGitOutputBytes",
  "maxGitWallMs",
] as const);

const WRITE_KEYS = Object.freeze(["relativePath", "bytes"] as const);
const CANONICAL_ARRAY_INDEX = /^(?:0|[1-9]\d*)$/u;
const MINIMUM_POSITIVE_LIMIT = 1;
const MINIMUM_ARRAY_LENGTH = 0;
const CONTENT_DIGEST_ALGORITHM = "sha256";
const PATH_LIMIT_VALIDATION_PROBE = "a";
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BUFFER_GETTER = typedArrayGetter("buffer");
const TYPED_ARRAY_BYTE_LENGTH_GETTER = typedArrayGetter("byteLength");
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

export const DEFAULT_LIMITS: BoundedRepositoryLimits = Object.freeze({
  maxEntries: DEFAULT_MAX_ENTRIES,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  ...DEFAULT_PORTABLE_REPOSITORY_PATH_LIMITS,
  maxGitOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
  maxGitWallMs: DEFAULT_GIT_WALL_MS,
});

export interface PreparedPath {
  readonly relativePath: string;
  readonly segments: readonly string[];
  readonly identity: string;
}

export interface PreparedWrite extends PreparedPath {
  readonly bytes: Buffer;
  readonly digest: string;
}

export type MutableUsage = MutableRepositoryUsage;

/**
 * Snapshot and validate optional repository limits without invoking input
 * accessors. Only supported own data properties are accepted.
 */
export function snapshotLimits(
  input: Partial<BoundedRepositoryLimits> = {},
): BoundedRepositoryLimits {
  const record = snapshotPlainDataRecord(
    input,
    "repository limits",
    REPOSITORY_LIMIT_KEYS.length,
  );
  const values = { ...DEFAULT_LIMITS } as Record<
    (typeof REPOSITORY_LIMIT_KEYS)[number],
    number
  >;
  for (const key of Object.keys(record)) {
    if (!(REPOSITORY_LIMIT_KEYS as readonly string[]).includes(key)) {
      throw invalidRepositoryInput(
        `repository limits contain unsupported key ${key}`,
      );
    }
    const value = record[key];
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < MINIMUM_POSITIVE_LIMIT
    ) {
      throw invalidRepositoryInput(`${key} must be a positive safe integer`);
    }
    values[key as (typeof REPOSITORY_LIMIT_KEYS)[number]] = value as number;
  }

  if (
    values.maxEntries > MAX_CONFIGURED_ENTRIES ||
    values.maxTotalBytes > MAX_CONFIGURED_TOTAL_BYTES ||
    values.maxFileBytes > MAX_CONFIGURED_FILE_BYTES ||
    values.maxGitOutputBytes > MAX_CONFIGURED_GIT_OUTPUT_BYTES ||
    values.maxGitWallMs > MAX_CONFIGURED_GIT_WALL_MS
  ) {
    throw invalidRepositoryInput("repository limits exceed a hard ceiling");
  }
  if (values.maxFileBytes > values.maxTotalBytes) {
    throw invalidRepositoryInput("maxFileBytes cannot exceed maxTotalBytes");
  }

  const pathLimits = projectPathLimits(values);
  try {
    validatePortableRepositoryPath(PATH_LIMIT_VALIDATION_PROBE, pathLimits);
  } catch (error) {
    throw new BoundedRepositoryError(
      "invalid_input",
      "repository path limits are invalid",
      { cause: error },
    );
  }
  return Object.freeze({
    maxEntries: values.maxEntries,
    maxTotalBytes: values.maxTotalBytes,
    maxFileBytes: values.maxFileBytes,
    ...pathLimits,
    maxGitOutputBytes: values.maxGitOutputBytes,
    maxGitWallMs: values.maxGitWallMs,
  });
}

/** Return the exact four-key path-policy projection required by the validator. */
export function projectPathLimits(
  limits: BoundedRepositoryLimits,
): PortableRepositoryPathLimits {
  return Object.freeze({
    maxDepth: limits.maxDepth,
    maxPathUtf8Bytes: limits.maxPathUtf8Bytes,
    maxSegmentUtf8Bytes: limits.maxSegmentUtf8Bytes,
    maxSegmentUtf16CodeUnits: limits.maxSegmentUtf16CodeUnits,
  });
}

/**
 * Produce immutable write records and private byte copies before an operation
 * is enqueued.
 */
export function snapshotWrites(
  input: readonly BoundedRepositoryByteWrite[],
  limits: BoundedRepositoryLimits,
  pathLimits: PortableRepositoryPathLimits,
): readonly PreparedWrite[] {
  const values = snapshotDenseArray(
    input,
    limits.maxEntries,
    "repository writes",
  );
  const result = new Array<PreparedWrite>(values.length);
  let aggregateBytes = 0;

  for (let index = 0; index < values.length; index += 1) {
    const label = `repository write ${index}`;
    const record = snapshotPlainDataRecord(
      values[index],
      label,
      WRITE_KEYS.length,
    );
    assertExactKeys(record, WRITE_KEYS, label);
    const relativePath = record.relativePath;
    if (typeof relativePath !== "string") {
      throw invalidRepositoryInput(`${label}.relativePath must be a string`);
    }
    const segments = validatePortableRepositoryPath(relativePath, pathLimits);
    const bytes = copyBytes(record.bytes, limits.maxFileBytes);
    if (aggregateBytes > limits.maxTotalBytes - bytes.byteLength) {
      throw repositoryQuotaError(
        "repository byte-write batch exceeds maxTotalBytes",
      );
    }
    aggregateBytes += bytes.byteLength;
    result[index] = Object.freeze({
      relativePath,
      segments,
      identity: portablePathIdentity(relativePath, pathLimits),
      bytes,
      digest: digestBytes(bytes),
    });
  }
  return Object.freeze(result);
}

/** Snapshot and validate the bounded, dense path list accepted by gitAdd. */
export function snapshotGitPaths(
  input: readonly string[],
  pathLimits: PortableRepositoryPathLimits,
): readonly string[] {
  const values = snapshotDenseArray(input, MAX_GIT_ARGUMENT_COUNT, "Git paths");
  if (values.length === MINIMUM_ARRAY_LENGTH) {
    throw invalidRepositoryInput("gitAdd requires a non-empty path list");
  }

  const result = new Array<string>(values.length);
  let aggregateBytes = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string") {
      throw invalidRepositoryInput(`Git path ${index} is not a string`);
    }
    validatePortableRepositoryPath(value, pathLimits);
    const pathBytes = Buffer.byteLength(value, "utf8");
    if (aggregateBytes > MAX_GIT_ARGUMENT_BYTES - pathBytes) {
      throw repositoryQuotaError(
        "gitAdd path arguments exceed their byte limit",
      );
    }
    aggregateBytes += pathBytes;
    result[index] = value;
  }
  return Object.freeze(result);
}

/** Snapshot one validated portable path and its conservative identity. */
export function snapshotPath(
  relativePath: string,
  limits: PortableRepositoryPathLimits,
): PreparedPath {
  const segments = validatePortableRepositoryPath(relativePath, limits);
  return Object.freeze({
    relativePath,
    segments,
    identity: portablePathIdentity(relativePath, limits),
  });
}

/**
 * Snapshot a dense ordinary array exclusively through own data descriptors.
 * Proxies, subclassed arrays, holes, accessors, symbols, and extra properties
 * are rejected.
 */
export function snapshotDenseArray(
  input: readonly unknown[],
  maximum: number,
  label: string,
): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    nodeUtilTypes.isProxy(input) ||
    Object.getPrototypeOf(input) !== Array.prototype
  ) {
    throw invalidRepositoryInput(`${label} must be a non-proxy ordinary array`);
  }
  if (!Number.isSafeInteger(maximum) || maximum < MINIMUM_ARRAY_LENGTH) {
    throw invalidRepositoryInput(`${label} item limit is invalid`);
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    throw invalidRepositoryInput(`${label} has an invalid length descriptor`);
  }
  const length = lengthDescriptor.value as unknown;
  if (
    !Number.isSafeInteger(length) ||
    (length as number) < MINIMUM_ARRAY_LENGTH
  ) {
    throw invalidRepositoryInput(`${label} has an invalid length`);
  }
  if ((length as number) > maximum) {
    throw repositoryQuotaError(`${label} exceeds its item limit`);
  }

  const ownKeys = Reflect.ownKeys(input);
  for (const key of ownKeys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !isArrayIndex(key, length as number)) {
      throw invalidRepositoryInput(`${label} contains an unsupported property`);
    }
  }

  const result = new Array<unknown>(length as number);
  for (let index = 0; index < result.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined) {
      throw invalidRepositoryInput(`${label} is sparse at index ${index}`);
    }
    if (!("value" in descriptor)) {
      throw invalidRepositoryInput(
        `${label} index ${index} must be a data property`,
      );
    }
    result[index] = descriptor.value as unknown;
  }
  return Object.freeze(result);
}

/** Snapshot a bounded plain record without evaluating accessors. */
export function snapshotPlainDataRecord(
  input: unknown,
  label: string,
  maximumProperties: number = REPOSITORY_LIMIT_KEYS.length,
): Readonly<Record<string, unknown>> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    nodeUtilTypes.isProxy(input)
  ) {
    throw invalidRepositoryInput(`${label} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidRepositoryInput(`${label} must be a plain object`);
  }
  if (
    !Number.isSafeInteger(maximumProperties) ||
    maximumProperties < MINIMUM_ARRAY_LENGTH
  ) {
    throw invalidRepositoryInput(`${label} property limit is invalid`);
  }

  const keys = Reflect.ownKeys(input);
  if (keys.length > maximumProperties) {
    throw invalidRepositoryInput(`${label} contains too many properties`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") {
      throw invalidRepositoryInput(`${label} contains a symbol key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw invalidRepositoryInput(`${label}.${key} must be a data property`);
    }
    result[key] = descriptor.value as unknown;
  }
  return Object.freeze(result);
}

/** Require a snapshotted record to contain exactly the expected keys. */
export function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(record);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    throw invalidRepositoryInput(
      `${label} must contain exactly ${expected.join(" and ")}`,
    );
  }
}

/** Copy a bounded Uint8Array through typed-array intrinsics. */
export function copyBytes(value: unknown, maximum: number): Buffer {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    throw invalidRepositoryInput(
      "repository write bytes must be a bounded Uint8Array copy",
    );
  }
  if (!Number.isSafeInteger(maximum) || maximum < MINIMUM_ARRAY_LENGTH) {
    throw invalidRepositoryInput("repository write byte limit is invalid");
  }

  try {
    const buffer = Reflect.apply(
      TYPED_ARRAY_BUFFER_GETTER,
      value,
      [],
    ) as ArrayBufferLike;
    const byteLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as unknown;
    if (
      nodeUtilTypes.isSharedArrayBuffer(buffer) ||
      !Number.isSafeInteger(byteLength) ||
      (byteLength as number) < MINIMUM_ARRAY_LENGTH ||
      (byteLength as number) > maximum
    ) {
      throw invalidRepositoryInput(
        "repository write bytes must be a bounded Uint8Array copy",
      );
    }
    const copy = Buffer.alloc(byteLength as number);
    Reflect.apply(UINT8_ARRAY_SET, copy, [value]);
    return copy;
  } catch (error) {
    if (error instanceof BoundedRepositoryError) throw error;
    throw new BoundedRepositoryError(
      "invalid_input",
      "repository write bytes could not be copied safely",
      { cause: error },
    );
  }
}

/** Snapshot a well-formed string constrained by its UTF-8 byte length. */
export function snapshotBoundedString(
  value: unknown,
  maximumBytes: number,
  label: string,
): string {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < MINIMUM_ARRAY_LENGTH
  ) {
    throw invalidRepositoryInput(`${label} byte limit is invalid`);
  }
  if (
    typeof value !== "string" ||
    value.length > maximumBytes ||
    !isWellFormedUnicode(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw invalidRepositoryInput(
      `${label} is malformed or exceeds its byte limit`,
    );
  }
  return value;
}

/** Snapshot the one data-only deterministic test hook without invoking accessors. */
export function snapshotRepositoryTestHooks(
  hooks: BoundedRepositoryTestHooks,
): BoundedRepositoryTestHooks {
  const descriptor =
    hooks !== null && typeof hooks === "object" && !nodeUtilTypes.isProxy(hooks)
      ? Object.getOwnPropertyDescriptor(hooks, "hit")
      : undefined;
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    throw invalidRepositoryInput("repository test hooks are invalid");
  }
  return Object.freeze({ hit: descriptor.value });
}

/** Enforce repository entry and byte quotas for a precomputed projection. */
export function assertProjectedUsage(
  usage: Readonly<MutableRepositoryUsage>,
  limits: BoundedRepositoryLimits,
): void {
  if (usage.entries > limits.maxEntries) {
    throw repositoryQuotaError(
      "repository byte-write batch exceeds maxEntries",
    );
  }
  if (usage.totalBytes > limits.maxTotalBytes) {
    throw repositoryQuotaError(
      "repository byte-write batch exceeds maxTotalBytes",
    );
  }
}

/** Return the deterministic content identity stored in the ownership ledger. */
export function digestBytes(bytes: Uint8Array): string {
  return createHash(CONTENT_DIGEST_ALGORITHM).update(bytes).digest("hex");
}

function isArrayIndex(key: string, length: number): boolean {
  if (!CANONICAL_ARRAY_INDEX.test(key)) return false;
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= MINIMUM_ARRAY_LENGTH &&
    index < length
  );
}

function typedArrayGetter(name: "buffer" | "byteLength"): () => unknown {
  const getter = Object.getOwnPropertyDescriptor(
    TYPED_ARRAY_PROTOTYPE,
    name,
  )?.get;
  if (getter === undefined) {
    throw new TypeError(`missing intrinsic typed-array ${name} getter`);
  }
  return getter;
}
