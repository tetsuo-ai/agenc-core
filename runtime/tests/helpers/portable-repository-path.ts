import { types as nodeUtilTypes } from "node:util";

import {
  isUnicode15_1RepertoireScalar,
  UNICODE_15_1_REPERTOIRE_VERSION,
} from "./unicode-15-1-repertoire.js";

export const MAX_PORTABLE_REPOSITORY_PATH_DEPTH = 1_024;
export const MAX_PORTABLE_REPOSITORY_PATH_UTF8_BYTES = 1_048_576;
export const MAX_PORTABLE_REPOSITORY_SEGMENT_UTF8_BYTES = 65_536;
export const MAX_PORTABLE_REPOSITORY_SEGMENT_UTF16_CODE_UNITS = 65_536;

const DEFAULT_PATH_DEPTH = 32;
const DEFAULT_PATH_UTF8_BYTES = 4_096;
const DEFAULT_SEGMENT_UTF8_BYTES = 255;
const DEFAULT_SEGMENT_UTF16_CODE_UNITS = 255;
const WINDOWS_DRIVE_PREFIX = /^[a-z]:/iu;
const WINDOWS_FORBIDDEN_CHARACTER = /[<>:"|?*]/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DEVICE_BASENAME =
  /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])$/u;
// Mirror the PowerShell Git guard's deliberately broad git~N reservation.
const WINDOWS_DOT_GIT_SHORT_ALIAS = /^git~[0-9]+$/u;
// NTFS can be configured to generate short names with extended OEM/DBCS
// characters. Match the 1-8 code-point base and optional 1-3 code-point
// extension independently of code page so every host rejects the same alias.
const WINDOWS_8_3_TILDE_ALIAS =
  /^(?=[^.]{1,8}(?:\.[^.]{1,3})?$)[^ .]+~[0-9]+(?:\.[^ .]{1,3})?$/u;
const INTERNAL_SEGMENT_IDENTITIES = new Set([".git", ".agenc-fnd-control"]);
const PATH_LIMIT_KEYS = Object.freeze([
  "maxDepth",
  "maxPathUtf8Bytes",
  "maxSegmentUtf8Bytes",
  "maxSegmentUtf16CodeUnits",
] as const);

const stringNormalize = String.prototype.normalize;
const stringToLowerCase = String.prototype.toLowerCase;
const stringToUpperCase = String.prototype.toUpperCase;

export interface PortableRepositoryPathLimits {
  readonly maxDepth: number;
  readonly maxPathUtf8Bytes: number;
  readonly maxSegmentUtf8Bytes: number;
  readonly maxSegmentUtf16CodeUnits: number;
}

export const DEFAULT_PORTABLE_REPOSITORY_PATH_LIMITS: PortableRepositoryPathLimits =
  Object.freeze({
    maxDepth: DEFAULT_PATH_DEPTH,
    maxPathUtf8Bytes: DEFAULT_PATH_UTF8_BYTES,
    maxSegmentUtf8Bytes: DEFAULT_SEGMENT_UTF8_BYTES,
    maxSegmentUtf16CodeUnits: DEFAULT_SEGMENT_UTF16_CODE_UNITS,
  });

export type PortableRepositoryPathErrorCode =
  | "absolute_path"
  | "control_character"
  | "dot_segment"
  | "empty_path"
  | "forbidden_character"
  | "invalid_limits"
  | "malformed_unicode"
  | "path_depth_limit"
  | "path_type"
  | "path_utf8_limit"
  | "reserved_segment"
  | "segment_utf16_limit"
  | "segment_utf8_limit"
  | "separator"
  | "trailing_character"
  | "unicode_repertoire";

export class PortableRepositoryPathError extends Error {
  readonly code: PortableRepositoryPathErrorCode;

  constructor(code: PortableRepositoryPathErrorCode, message: string) {
    super(message);
    this.name = "PortableRepositoryPathError";
    this.code = code;
  }
}

/** Return whether a string contains only paired UTF-16 surrogate code units. */
export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const lowSurrogate = value.charCodeAt(index + 1);
      if (lowSurrogate < 0xdc00 || lowSurrogate > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

/**
 * Validate a repository-relative path against a filesystem-portable policy.
 *
 * The returned segments are an immutable copy. No filesystem access occurs.
 */
export function validatePortableRepositoryPath(
  relativePath: string,
  inputLimits: PortableRepositoryPathLimits = DEFAULT_PORTABLE_REPOSITORY_PATH_LIMITS,
): readonly string[] {
  const limits = validatePathLimits(inputLimits);
  if (typeof relativePath !== "string") {
    throw new PortableRepositoryPathError(
      "path_type",
      "repository path must be a string",
    );
  }
  if (relativePath.length === 0) {
    throw new PortableRepositoryPathError(
      "empty_path",
      "repository path must not be empty",
    );
  }
  if (relativePath.length > limits.maxPathUtf8Bytes) {
    throw new PortableRepositoryPathError(
      "path_utf8_limit",
      "repository path exceeds maxPathUtf8Bytes",
    );
  }
  if (!isWellFormedUnicode(relativePath)) {
    throw new PortableRepositoryPathError(
      "malformed_unicode",
      "repository path contains malformed UTF-16",
    );
  }
  if (!usesPinnedUnicodeRepertoire(relativePath)) {
    throw new PortableRepositoryPathError(
      "unicode_repertoire",
      `repository path contains a scalar newer than Unicode ${UNICODE_15_1_REPERTOIRE_VERSION}`,
    );
  }
  if (
    WINDOWS_DRIVE_PREFIX.test(relativePath) ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\")
  ) {
    throw new PortableRepositoryPathError(
      "absolute_path",
      "repository path must be relative",
    );
  }
  if (relativePath.includes("\\")) {
    throw new PortableRepositoryPathError(
      "separator",
      "repository path must use single forward-slash separators",
    );
  }
  if (CONTROL_CHARACTER.test(relativePath)) {
    throw new PortableRepositoryPathError(
      "control_character",
      "repository path contains a control character",
    );
  }
  if (Buffer.byteLength(relativePath, "utf8") > limits.maxPathUtf8Bytes) {
    throw new PortableRepositoryPathError(
      "path_utf8_limit",
      "repository path exceeds maxPathUtf8Bytes",
    );
  }

  const segments = relativePath.split("/");
  if (segments.length > limits.maxDepth) {
    throw new PortableRepositoryPathError(
      "path_depth_limit",
      "repository path exceeds maxDepth",
    );
  }
  for (const segment of segments) validateSegment(segment, limits);
  return Object.freeze(segments.slice());
}

/** Produce a conservative identity for case/normalization-portable collisions. */
export function portablePathIdentity(
  relativePath: string,
  limits: PortableRepositoryPathLimits = DEFAULT_PORTABLE_REPOSITORY_PATH_LIMITS,
): string {
  return validatePortableRepositoryPath(relativePath, limits)
    .map(portableSegmentIdentity)
    .join("/");
}

/**
 * Fold one bounded Unicode-15.1 string for the Node/Bun parity contract.
 * Repository paths call this only after the same repertoire check.
 */
export function portableUnicodeCaseIdentity(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_PORTABLE_REPOSITORY_PATH_UTF8_BYTES ||
    !isWellFormedUnicode(value) ||
    !usesPinnedUnicodeRepertoire(value) ||
    Buffer.byteLength(value, "utf8") > MAX_PORTABLE_REPOSITORY_PATH_UTF8_BYTES
  ) {
    throw new PortableRepositoryPathError(
      "unicode_repertoire",
      `portable Unicode identity requires a bounded Unicode ${UNICODE_15_1_REPERTOIRE_VERSION} string`,
    );
  }
  return foldPinnedUnicode(value);
}

function validateSegment(
  segment: string,
  limits: PortableRepositoryPathLimits,
): void {
  if (segment.length === 0) {
    throw new PortableRepositoryPathError(
      "separator",
      "repository path contains an empty segment",
    );
  }
  if (segment === "." || segment === "..") {
    throw new PortableRepositoryPathError(
      "dot_segment",
      "repository path contains a dot segment",
    );
  }
  if (segment.length > limits.maxSegmentUtf16CodeUnits) {
    throw new PortableRepositoryPathError(
      "segment_utf16_limit",
      "repository path segment exceeds maxSegmentUtf16CodeUnits",
    );
  }
  if (Buffer.byteLength(segment, "utf8") > limits.maxSegmentUtf8Bytes) {
    throw new PortableRepositoryPathError(
      "segment_utf8_limit",
      "repository path segment exceeds maxSegmentUtf8Bytes",
    );
  }
  if (WINDOWS_FORBIDDEN_CHARACTER.test(segment)) {
    throw new PortableRepositoryPathError(
      "forbidden_character",
      "repository path segment contains a Windows-forbidden character",
    );
  }
  if (segment.endsWith(".") || segment.endsWith(" ")) {
    throw new PortableRepositoryPathError(
      "trailing_character",
      "repository path segment ends in a non-portable character",
    );
  }

  const identity = portableSegmentIdentity(segment);
  const deviceBase = identity.split(".", 1)[0] ?? identity;
  if (
    INTERNAL_SEGMENT_IDENTITIES.has(identity) ||
    WINDOWS_DEVICE_BASENAME.test(deviceBase) ||
    WINDOWS_DOT_GIT_SHORT_ALIAS.test(identity) ||
    WINDOWS_8_3_TILDE_ALIAS.test(segment) ||
    WINDOWS_8_3_TILDE_ALIAS.test(identity)
  ) {
    throw new PortableRepositoryPathError(
      "reserved_segment",
      `repository path uses reserved segment ${JSON.stringify(segment)}`,
    );
  }
}

function portableSegmentIdentity(segment: string): string {
  return foldPinnedUnicode(segment);
}

function foldPinnedUnicode(segment: string): string {
  const normalized = stringNormalize.call(segment, "NFC");
  const lowerCased = stringToLowerCase.call(normalized);
  const caseFolded = stringToLowerCase.call(stringToUpperCase.call(lowerCased));
  return stringNormalize.call(caseFolded, "NFC");
}

function usesPinnedUnicodeRepertoire(value: string): boolean {
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    if (codePoint === undefined || !isUnicode15_1RepertoireScalar(codePoint)) {
      return false;
    }
  }
  return true;
}

function validatePathLimits(
  input: PortableRepositoryPathLimits,
): PortableRepositoryPathLimits {
  if (
    input === null ||
    typeof input !== "object" ||
    nodeUtilTypes.isProxy(input)
  ) {
    throw invalidLimits("path limits must be a non-proxy object");
  }
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidLimits("path limits must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (
    descriptorKeys.length !== PATH_LIMIT_KEYS.length ||
    descriptorKeys.some(
      (key) =>
        typeof key !== "string" ||
        !(PATH_LIMIT_KEYS as readonly string[]).includes(key),
    )
  ) {
    throw invalidLimits("path limits must contain exactly the supported keys");
  }

  const values = Object.create(null) as Record<
    (typeof PATH_LIMIT_KEYS)[number],
    number
  >;
  for (const key of PATH_LIMIT_KEYS) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !Number.isSafeInteger(descriptor.value) ||
      (descriptor.value as number) < 1
    ) {
      throw invalidLimits(`${key} must be a positive safe integer`);
    }
    values[key] = descriptor.value as number;
  }
  if (values.maxDepth > MAX_PORTABLE_REPOSITORY_PATH_DEPTH) {
    throw invalidLimits("maxDepth exceeds its hard ceiling");
  }
  if (values.maxPathUtf8Bytes > MAX_PORTABLE_REPOSITORY_PATH_UTF8_BYTES) {
    throw invalidLimits("maxPathUtf8Bytes exceeds its hard ceiling");
  }
  if (values.maxSegmentUtf8Bytes > MAX_PORTABLE_REPOSITORY_SEGMENT_UTF8_BYTES) {
    throw invalidLimits("maxSegmentUtf8Bytes exceeds its hard ceiling");
  }
  if (
    values.maxSegmentUtf16CodeUnits >
    MAX_PORTABLE_REPOSITORY_SEGMENT_UTF16_CODE_UNITS
  ) {
    throw invalidLimits("maxSegmentUtf16CodeUnits exceeds its hard ceiling");
  }
  if (values.maxSegmentUtf8Bytes > values.maxPathUtf8Bytes) {
    throw invalidLimits("maxSegmentUtf8Bytes cannot exceed maxPathUtf8Bytes");
  }
  if (values.maxSegmentUtf16CodeUnits > values.maxPathUtf8Bytes) {
    throw invalidLimits(
      "maxSegmentUtf16CodeUnits cannot exceed maxPathUtf8Bytes",
    );
  }
  return Object.freeze({
    maxDepth: values.maxDepth,
    maxPathUtf8Bytes: values.maxPathUtf8Bytes,
    maxSegmentUtf8Bytes: values.maxSegmentUtf8Bytes,
    maxSegmentUtf16CodeUnits: values.maxSegmentUtf16CodeUnits,
  });
}

function invalidLimits(message: string): PortableRepositoryPathError {
  return new PortableRepositoryPathError("invalid_limits", message);
}
