import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";

export class BoundedRegularFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundedRegularFileError";
  }
}

interface RegularFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** @internal Deterministic race seam for the synchronous reader contract. */
export interface BoundedRegularFileSyncTestHooks {
  readonly afterRead?: () => void;
}

/** @internal Deterministic race seam for the asynchronous reader contract. */
export interface BoundedRegularFileAsyncTestHooks {
  readonly afterRead?: () => Promise<void> | void;
}

export function readBoundedRegularFileSync(
  path: string,
  maxBytes: number,
  hooks: BoundedRegularFileSyncTestHooks = {},
): string {
  assertMaxBytes(maxBytes);
  let descriptor: number | undefined;
  let value: Buffer | undefined;
  let primaryError: unknown;
  try {
    const before = lstatSync(path, { bigint: true });
    assertRegularFile(before);
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const afterOpen = lstatSync(path, { bigint: true });
    assertSameRegularFile(before, opened, afterOpen);
    if (opened.size > BigInt(maxBytes)) {
      throw new BoundedRegularFileError(
        `regular file exceeds ${maxBytes} bytes`,
      );
    }
    value = readBoundedDescriptorSync(descriptor, Number(opened.size));
    hooks.afterRead?.();
    const afterRead = fstatSync(descriptor, { bigint: true });
    const pathAfterRead = lstatSync(path, { bigint: true });
    assertSameRegularFile(before, opened, afterOpen, afterRead, pathAfterRead);
    if (afterRead.size !== BigInt(value.byteLength)) {
      throw new BoundedRegularFileError(
        "regular file length changed while reading",
      );
    }
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  throwReadOrCloseError(primaryError, closeError);
  return (value ?? Buffer.alloc(0)).toString("utf8");
}

export async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  hooks: BoundedRegularFileAsyncTestHooks = {},
): Promise<string> {
  return (await readBoundedRegularFileBuffer(path, maxBytes, hooks)).toString(
    "utf8",
  );
}

/**
 * Read exact bytes from a stable regular non-link file without ever allocating
 * beyond the caller's bound.
 */
export async function readBoundedRegularFileBytes(
  path: string,
  maxBytes: number,
  hooks: BoundedRegularFileAsyncTestHooks = {},
): Promise<Uint8Array> {
  return readBoundedRegularFileBuffer(path, maxBytes, hooks);
}

async function readBoundedRegularFileBuffer(
  path: string,
  maxBytes: number,
  hooks: BoundedRegularFileAsyncTestHooks,
): Promise<Buffer> {
  assertMaxBytes(maxBytes);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let value: Buffer | undefined;
  let primaryError: unknown;
  try {
    const before = await lstat(path, { bigint: true });
    assertRegularFile(before);
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    const afterOpen = await lstat(path, { bigint: true });
    assertSameRegularFile(before, opened, afterOpen);
    if (opened.size > BigInt(maxBytes)) {
      throw new BoundedRegularFileError(
        `regular file exceeds ${maxBytes} bytes`,
      );
    }
    value = await readBoundedHandle(handle, Number(opened.size));
    await hooks.afterRead?.();
    const afterRead = await handle.stat({ bigint: true });
    const pathAfterRead = await lstat(path, { bigint: true });
    assertSameRegularFile(before, opened, afterOpen, afterRead, pathAfterRead);
    if (afterRead.size !== BigInt(value.byteLength)) {
      throw new BoundedRegularFileError(
        "regular file length changed while reading",
      );
    }
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown;
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  throwReadOrCloseError(primaryError, closeError);
  return value ?? Buffer.alloc(0);
}

function readBoundedDescriptorSync(
  descriptor: number,
  expectedBytes: number,
): Buffer {
  const buffer = Buffer.allocUnsafe(expectedBytes);
  let length = 0;
  while (length < buffer.length) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      length,
      buffer.length - length,
      null,
    );
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

async function readBoundedHandle(
  handle: Awaited<ReturnType<typeof open>>,
  expectedBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(expectedBytes);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      length,
      buffer.length - length,
      null,
    );
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

function assertMaxBytes(maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > 16_777_216
  ) {
    throw new TypeError("bounded regular-file byte limit is invalid");
  }
}

function assertRegularFile(identity: RegularFileIdentity): void {
  if (!identity.isFile() || identity.isSymbolicLink()) {
    throw new BoundedRegularFileError(
      "lifecycle metadata is not a regular non-link file",
    );
  }
}

function assertSameRegularFile(
  ...identities: readonly RegularFileIdentity[]
): void {
  const first = identities[0];
  if (first === undefined) {
    throw new TypeError("regular-file identity proof requires a snapshot");
  }
  for (const identity of identities) assertRegularFile(identity);
  if (
    identities.some((identity) => !sameRegularFileSnapshot(first, identity))
  ) {
    throw new BoundedRegularFileError(
      "lifecycle metadata file identity changed while reading",
    );
  }
}

function sameRegularFileSnapshot(
  left: RegularFileIdentity,
  right: RegularFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function throwReadOrCloseError(
  primaryError: unknown,
  closeError: unknown,
): void {
  if (primaryError !== undefined) {
    if (closeError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "bounded regular-file read and descriptor cleanup both failed",
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (closeError !== undefined) throw closeError;
}
