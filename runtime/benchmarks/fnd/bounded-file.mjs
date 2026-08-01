import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";

const EOF_PROBE_BYTES = 1;
export const MAX_BOUNDED_REGULAR_FILE_BYTES = 67_108_864;
const READ_ONLY_BOUND_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0);
const DEFAULT_FILE_OPERATIONS = Object.freeze({
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
});

export function readBoundedRegularFile(
  path,
  maximumBytes,
  label,
  operationOverrides = {},
) {
  validateOptions(path, maximumBytes, label, operationOverrides);
  const operations = { ...DEFAULT_FILE_OPERATIONS, ...operationOverrides };
  const pathBefore = snapshotRegularFile(
    operations.lstatSync(path, { bigint: true }),
    maximumBytes,
    label,
  );
  const descriptor = operations.openSync(path, READ_ONLY_BOUND_FLAGS);
  let result;
  let readFailure;
  try {
    result = readOpenedFile(
      descriptor,
      path,
      pathBefore,
      maximumBytes,
      label,
      operations,
    );
  } catch (error) {
    readFailure = error;
  }

  let closeFailure;
  try {
    operations.closeSync(descriptor);
  } catch (error) {
    closeFailure = error;
  }
  if (readFailure !== undefined && closeFailure !== undefined) {
    throw new AggregateError(
      [readFailure, closeFailure],
      `${label} read and descriptor close both failed`,
    );
  }
  if (readFailure !== undefined) throw readFailure;
  if (closeFailure !== undefined) {
    throw new Error(`${label} descriptor did not close cleanly`, {
      cause: closeFailure,
    });
  }
  if (result === undefined) {
    throw new Error(`${label} descriptor read produced no result`);
  }
  return result;
}

function readOpenedFile(
  descriptor,
  path,
  pathBefore,
  maximumBytes,
  label,
  operations,
) {
  const descriptorBefore = snapshotRegularFile(
    operations.fstatSync(descriptor, { bigint: true }),
    maximumBytes,
    label,
  );
  assertSameSnapshot(
    pathBefore,
    descriptorBefore,
    label,
    "while it was opened",
  );

  const allocation = Buffer.alloc(maximumBytes + EOF_PROBE_BYTES);
  let bytesRead = 0;
  while (bytesRead < allocation.length) {
    const count = operations.readSync(
      descriptor,
      allocation,
      bytesRead,
      allocation.length - bytesRead,
      bytesRead,
    );
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label} descriptor returned an invalid read count`);
    }
    if (count === 0) break;
    bytesRead += count;
  }
  if (bytesRead > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }

  const descriptorAfter = snapshotRegularFile(
    operations.fstatSync(descriptor, { bigint: true }),
    maximumBytes,
    label,
  );
  const pathAfter = snapshotRegularFile(
    operations.lstatSync(path, { bigint: true }),
    maximumBytes,
    label,
  );
  assertSameSnapshot(
    descriptorBefore,
    descriptorAfter,
    label,
    "while it was read",
  );
  assertSameSnapshot(descriptorBefore, pathAfter, label, "at its pathname");
  if (bytesRead !== Number(descriptorBefore.size)) {
    throw new Error(`${label} length changed while it was read`);
  }
  return allocation.subarray(0, bytesRead);
}

function snapshotRegularFile(metadata, maximumBytes, label) {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (metadata.nlink !== 1n) {
    throw new Error(`${label} must be a singly linked file`);
  }
  if (metadata.size < 0n || metadata.size > BigInt(maximumBytes)) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  return Object.freeze({
    changedNs: metadata.ctimeNs,
    device: metadata.dev,
    inode: metadata.ino,
    links: metadata.nlink,
    mode: metadata.mode,
    modifiedNs: metadata.mtimeNs,
    size: metadata.size,
  });
}

function assertSameSnapshot(expected, actual, label, phase) {
  if (
    expected.changedNs !== actual.changedNs ||
    expected.device !== actual.device ||
    expected.inode !== actual.inode ||
    expected.links !== actual.links ||
    expected.mode !== actual.mode ||
    expected.modifiedNs !== actual.modifiedNs ||
    expected.size !== actual.size
  ) {
    throw new Error(`${label} changed ${phase}`);
  }
}

function validateOptions(path, maximumBytes, label, operationOverrides) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new Error("bounded file path must be a non-empty string");
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > MAX_BOUNDED_REGULAR_FILE_BYTES
  ) {
    throw new Error(
      `bounded file byte ceiling must be in [0, ${MAX_BOUNDED_REGULAR_FILE_BYTES}]`,
    );
  }
  if (typeof label !== "string" || label.length === 0) {
    throw new Error("bounded file label must be non-empty");
  }
  if (
    operationOverrides === null ||
    typeof operationOverrides !== "object" ||
    Array.isArray(operationOverrides)
  ) {
    throw new Error("bounded file operation overrides must be an object");
  }
}
