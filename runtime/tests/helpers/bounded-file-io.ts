import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { types as nodeUtilTypes } from "node:util";

import { isWellFormedUnicode } from "./portable-repository-path.js";

export const MAX_BOUNDED_FILE_READ_BYTES = 67_108_864;
export const MAX_BOUNDED_FILE_PATH_UTF8_BYTES = 32_768;
export const MAX_BOUNDED_FILE_LABEL_UTF8_BYTES = 1_024;

const EOF_PROBE_BYTES = 1;
const READ_ONLY_NO_FOLLOW_FLAGS =
  fsConstants.O_RDONLY |
  (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
const OPTION_KEYS = Object.freeze(["byteLimit", "label"] as const);
const DEFAULT_FILE_LABEL = "file";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BUFFER_GETTER = typedArrayGetter("buffer");
const TYPED_ARRAY_BYTE_LENGTH_GETTER = typedArrayGetter("byteLength");
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

export interface BoundedFileReadOptions {
  readonly byteLimit: number;
  readonly label?: string;
}

export type BoundedFileIoErrorCode =
  | "changed"
  | "hard_link"
  | "invalid_bytes"
  | "invalid_label"
  | "invalid_limit"
  | "invalid_options"
  | "invalid_path"
  | "invalid_type"
  | "limit"
  | "utf8";

export class BoundedFileIoError extends Error {
  readonly code: BoundedFileIoErrorCode;

  constructor(
    code: BoundedFileIoErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BoundedFileIoError";
    this.code = code;
  }
}

interface ValidatedReadOptions {
  readonly byteLimit: number;
  readonly label: string;
}

interface FileSnapshot {
  readonly device: bigint;
  readonly inode: bigint;
  readonly links: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
}

/**
 * Read one regular, singly linked file through a pinned and bounded descriptor.
 */
export async function readBoundedRegularFile(
  path: string,
  inputOptions: BoundedFileReadOptions,
): Promise<Buffer> {
  validateFilePath(path);
  const options = validateReadOptions(inputOptions);
  const pathBefore = await lstat(path, { bigint: true });
  const expected = snapshotRegularFile(pathBefore, options);
  const handle = await open(path, READ_ONLY_NO_FOLLOW_FLAGS);

  let result: Buffer | undefined;
  let primaryError: unknown;
  let primaryFailed = false;
  try {
    result = await readOpenedFile(handle, path, expected, options);
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  let closeError: unknown;
  let closeFailed = false;
  try {
    await handle.close();
  } catch (error) {
    closeFailed = true;
    closeError = error;
  }
  if (primaryFailed && closeFailed) {
    throw new AggregateError(
      [primaryError, closeError],
      `${options.label} read and descriptor close both failed`,
    );
  }
  if (primaryFailed) throw primaryError;
  if (closeFailed) {
    throw new BoundedFileIoError(
      "changed",
      `${options.label} descriptor did not close cleanly`,
      { cause: closeError },
    );
  }
  if (result === undefined) {
    throw new BoundedFileIoError(
      "changed",
      `${options.label} read completed without a result`,
    );
  }
  return result;
}

/** Decode bounded bytes without replacement characters or BOM elision. */
export function decodeFatalUtf8(bytes: Uint8Array, label: string): string {
  const safeLabel = validateLabel(label);
  if (!nodeUtilTypes.isUint8Array(bytes) || nodeUtilTypes.isProxy(bytes)) {
    throw new BoundedFileIoError(
      "invalid_bytes",
      `${safeLabel} bytes must be a bounded non-proxy Uint8Array`,
    );
  }

  let copy: Uint8Array;
  try {
    const buffer = Reflect.apply(
      TYPED_ARRAY_BUFFER_GETTER,
      bytes,
      [],
    ) as ArrayBufferLike;
    const byteLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      bytes,
      [],
    ) as unknown;
    if (
      nodeUtilTypes.isSharedArrayBuffer(buffer) ||
      !Number.isSafeInteger(byteLength) ||
      (byteLength as number) < 0 ||
      (byteLength as number) > MAX_BOUNDED_FILE_READ_BYTES
    ) {
      throw new BoundedFileIoError(
        "invalid_bytes",
        `${safeLabel} bytes must be a bounded non-proxy Uint8Array`,
      );
    }
    copy = new Uint8Array(byteLength as number);
    Reflect.apply(UINT8_ARRAY_SET, copy, [bytes]);
  } catch (error) {
    if (error instanceof BoundedFileIoError) throw error;
    throw new BoundedFileIoError(
      "invalid_bytes",
      `${safeLabel} bytes could not be copied safely`,
      { cause: error },
    );
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(copy);
  } catch (error) {
    throw new BoundedFileIoError("utf8", `${safeLabel} is not valid UTF-8`, {
      cause: error,
    });
  }
}

async function readOpenedFile(
  handle: FileHandle,
  path: string,
  expected: FileSnapshot,
  options: ValidatedReadOptions,
): Promise<Buffer> {
  const descriptorBefore = await handle.stat({ bigint: true });
  const opened = snapshotRegularFile(descriptorBefore, options);
  assertSameSnapshot(expected, opened, options.label, "while it was opened");

  const expectedSize = Number(opened.size);
  const allocationSize = expectedSize + EOF_PROBE_BYTES;
  const allocation = Buffer.alloc(allocationSize);
  let bytesRead = 0;
  while (bytesRead < allocationSize) {
    const read = await handle.read(
      allocation,
      bytesRead,
      allocationSize - bytesRead,
      bytesRead,
    );
    if (read.bytesRead === 0) break;
    bytesRead += read.bytesRead;
  }
  if (bytesRead > options.byteLimit) {
    throw new BoundedFileIoError(
      "limit",
      `${options.label} exceeds its ${options.byteLimit}-byte limit`,
    );
  }

  const descriptorAfter = snapshotRegularFile(
    await handle.stat({ bigint: true }),
    options,
  );
  const pathAfter = snapshotRegularFile(
    await lstat(path, { bigint: true }),
    options,
  );
  assertSameSnapshot(
    opened,
    descriptorAfter,
    options.label,
    "while it was read",
  );
  assertSameSnapshot(opened, pathAfter, options.label, "at its pathname");
  if (bytesRead !== expectedSize) {
    throw new BoundedFileIoError(
      "changed",
      `${options.label} length changed while it was read`,
    );
  }
  return Buffer.from(allocation.subarray(0, bytesRead));
}

function snapshotRegularFile(
  status: BigIntStats,
  options: ValidatedReadOptions,
): FileSnapshot {
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new BoundedFileIoError(
      "invalid_type",
      `${options.label} is not a regular file`,
    );
  }
  if (status.nlink === 0n) {
    throw new BoundedFileIoError(
      "changed",
      `${options.label} was unlinked while it was inspected`,
    );
  }
  if (status.nlink !== 1n) {
    throw new BoundedFileIoError(
      "hard_link",
      `${options.label} must be singly linked`,
    );
  }
  if (status.size < 0n || status.size > BigInt(options.byteLimit)) {
    throw new BoundedFileIoError(
      "limit",
      `${options.label} exceeds its ${options.byteLimit}-byte limit`,
    );
  }
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    links: status.nlink,
    mode: status.mode,
    size: status.size,
    modifiedNs: status.mtimeNs,
    changedNs: status.ctimeNs,
  });
}

function assertSameSnapshot(
  expected: FileSnapshot,
  actual: FileSnapshot,
  label: string,
  phase: string,
): void {
  if (
    expected.device !== actual.device ||
    expected.inode !== actual.inode ||
    expected.links !== actual.links ||
    expected.mode !== actual.mode ||
    expected.size !== actual.size ||
    expected.modifiedNs !== actual.modifiedNs ||
    expected.changedNs !== actual.changedNs
  ) {
    throw new BoundedFileIoError("changed", `${label} changed ${phase}`);
  }
}

function validateFilePath(path: string): void {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > MAX_BOUNDED_FILE_PATH_UTF8_BYTES ||
    path.includes("\0") ||
    !isWellFormedUnicode(path) ||
    Buffer.byteLength(path, "utf8") > MAX_BOUNDED_FILE_PATH_UTF8_BYTES
  ) {
    throw new BoundedFileIoError(
      "invalid_path",
      "bounded file path is invalid or exceeds its byte limit",
    );
  }
}

function validateReadOptions(
  input: BoundedFileReadOptions,
): ValidatedReadOptions {
  if (
    input === null ||
    typeof input !== "object" ||
    nodeUtilTypes.isProxy(input)
  ) {
    throw invalidOptions("read options must be a non-proxy object");
  }
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidOptions("read options must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (
      typeof key !== "string" ||
      !(OPTION_KEYS as readonly string[]).includes(key)
    ) {
      throw invalidOptions("read options contain an unsupported key");
    }
  }
  const byteLimitDescriptor = descriptors.byteLimit;
  if (
    byteLimitDescriptor === undefined ||
    !("value" in byteLimitDescriptor) ||
    !Number.isSafeInteger(byteLimitDescriptor.value) ||
    (byteLimitDescriptor.value as number) < 0 ||
    (byteLimitDescriptor.value as number) > MAX_BOUNDED_FILE_READ_BYTES
  ) {
    throw new BoundedFileIoError(
      "invalid_limit",
      `byteLimit must be a safe integer in [0, ${MAX_BOUNDED_FILE_READ_BYTES}]`,
    );
  }
  const labelDescriptor = descriptors.label;
  if (labelDescriptor !== undefined && !("value" in labelDescriptor)) {
    throw invalidOptions("read option label must be a data property");
  }
  return Object.freeze({
    byteLimit: byteLimitDescriptor.value as number,
    label: validateLabel(
      labelDescriptor === undefined
        ? DEFAULT_FILE_LABEL
        : (labelDescriptor.value as unknown),
    ),
  });
}

function validateLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_BOUNDED_FILE_LABEL_UTF8_BYTES ||
    !isWellFormedUnicode(value) ||
    CONTROL_CHARACTER.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_BOUNDED_FILE_LABEL_UTF8_BYTES
  ) {
    throw new BoundedFileIoError(
      "invalid_label",
      "bounded file label is invalid or exceeds its byte limit",
    );
  }
  return value;
}

function invalidOptions(message: string): BoundedFileIoError {
  return new BoundedFileIoError("invalid_options", message);
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
