import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve, win32 } from "node:path";
import {
  sameStats,
  verifiedDirectoryOpenFlags,
  verifiedFileOpenFlags,
} from "./verified-read.js";

const READ_CHUNK_BYTES = 64 * 1_024;

export interface ConfinedIoPolicy {
  readonly hardLinks: "allow" | "reject";
  readonly privateDirectory: boolean;
  readonly privateFile: boolean;
  readonly unavailableAlias:
    | "reject"
    | "identity-checked-path"
    | "windows-private-path";
  readonly verifyWindowsPrivatePath?: (
    path: string,
    role: "directory" | "file",
  ) => void;
}

export interface ConfinedDirectory {
  readonly path: string;
  readonly canonicalPath: string;
  readonly operationPath: string;
  readonly handle: FileHandle | undefined;
  readonly policy: ConfinedIoPolicy;
  verify(): Promise<void>;
}

export interface ConfinedFile {
  readonly path: string;
  readonly handle: FileHandle;
  readonly snapshot: BigIntStats;
  readonly root: ConfinedDirectory;
  verify(): Promise<void>;
}

export interface ConfinedIoHooks {
  readonly afterRootOpen?: (root: string) => void | Promise<void>;
  readonly afterCandidateOpen?: (candidate: string) => void | Promise<void>;
}

export class ConfinedIoError extends Error {
  constructor(
    readonly code:
      | "ROOT_UNSAFE"
      | "ROOT_CHANGED"
      | "DESCRIPTOR_UNSUPPORTED"
      | "CHILD_UNSAFE"
      | "CHILD_CHANGED"
      | "CHILD_OUTSIDE_ROOT"
      | "CHILD_TOO_LARGE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConfinedIoError";
  }
}

export async function withConfinedDirectory<Result>(
  path: string,
  policy: ConfinedIoPolicy,
  operation: (root: ConfinedDirectory) => Promise<Result>,
  hooks: ConfinedIoHooks = {},
): Promise<Result> {
  const lexicalPath = resolve(path);
  const before = await lstat(lexicalPath, { bigint: true });
  assertDirectory(before, policy);
  const canonicalPath = await realpath(lexicalPath);
  verifyPrivatePath(canonicalPath, "directory", policy);
  const handle =
    process.platform === "win32"
      ? undefined
      : await open(lexicalPath, verifiedDirectoryOpenFlags());
  try {
    if (handle !== undefined) {
      const opened = await handle.stat({ bigint: true });
      assertDirectory(opened, policy);
      if (!sameIdentity(before, opened)) {
        throw new ConfinedIoError(
          "ROOT_CHANGED",
          `root changed while opening: ${lexicalPath}`,
        );
      }
    }
    const descriptorPath =
      handle === undefined
        ? undefined
        : await descriptorDirectoryPath(handle, canonicalPath, before);
    if (descriptorPath === undefined && !allowsPathFallback(policy)) {
      throw new ConfinedIoError(
        "DESCRIPTOR_UNSUPPORTED",
        `descriptor-confined I/O is unsupported on ${process.platform}`,
      );
    }
    const root: ConfinedDirectory = {
      path: lexicalPath,
      canonicalPath,
      operationPath: descriptorPath ?? canonicalPath,
      handle,
      policy,
      async verify() {
        try {
          const [current, canonical, opened] = await Promise.all([
            lstat(lexicalPath, { bigint: true }),
            realpath(lexicalPath),
            handle?.stat({ bigint: true }),
          ]);
          assertDirectory(current, policy);
          if (opened !== undefined) assertDirectory(opened, policy);
          verifyPrivatePath(canonical, "directory", policy);
          if (
            canonical !== canonicalPath ||
            !sameIdentity(before, current) ||
            (opened !== undefined && !sameIdentity(before, opened))
          ) {
            throw new Error("root identity or canonical path changed");
          }
        } catch (cause) {
          throw new ConfinedIoError(
            "ROOT_CHANGED",
            `root changed during I/O: ${lexicalPath}`,
            { cause },
          );
        }
      },
    };
    await hooks.afterRootOpen?.(lexicalPath);
    await root.verify();
    const result = await operation(root);
    await root.verify();
    return result;
  } finally {
    await handle?.close();
  }
}

export async function withRegularChild<Result>(
  root: ConfinedDirectory,
  name: string,
  limits: { readonly maximumBytes: number; readonly expectedBytes?: number },
  operation: (file: ConfinedFile) => Promise<Result>,
  hooks: ConfinedIoHooks = {},
): Promise<Result | undefined> {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    basename(name) !== name ||
    win32.basename(name) !== name ||
    /[\\/]/u.test(name) ||
    name.includes("\0")
  ) {
    throw new TypeError("confined child must be one basename");
  }
  if (!Number.isSafeInteger(limits.maximumBytes) || limits.maximumBytes < 0) {
    throw new TypeError(
      "confined read byte limit must be a non-negative safe integer",
    );
  }
  if (
    limits.expectedBytes !== undefined &&
    (!Number.isSafeInteger(limits.expectedBytes) ||
      limits.expectedBytes < 0 ||
      limits.expectedBytes > limits.maximumBytes)
  ) {
    throw new TypeError("confined read expected length must fit its byte limit");
  }
  await root.verify();
  const path = join(root.operationPath, name);
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  assertRegularFile(before, root.policy);
  assertByteLength(before, limits);
  assertPrivateChildPath(path, root.policy);
  let handle: FileHandle;
  try {
    handle = await open(path, verifiedFileOpenFlags());
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (!isChildReplacementError(cause)) throw cause;
    throw new ConfinedIoError(
      "CHILD_CHANGED",
      `child changed while opening: ${path}`,
      { cause },
    );
  }
  try {
    const snapshot = await handle.stat({ bigint: true });
    assertRegularFile(snapshot, root.policy);
    assertByteLength(snapshot, limits);
    if (!sameSnapshot(before, snapshot)) {
      throw new ConfinedIoError(
        "CHILD_CHANGED",
        `child changed while opening: ${path}`,
      );
    }
    const file: ConfinedFile = {
      path,
      handle,
      snapshot,
      root,
      async verify() {
        try {
          const [opened, current, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(path, { bigint: true }),
            realpath(path),
          ]);
          assertRegularFile(opened, root.policy);
          assertRegularFile(current, root.policy);
          assertPrivateChildPath(path, root.policy);
          if (!sameSnapshot(snapshot, opened) || !sameSnapshot(snapshot, current)) {
            throw new ConfinedIoError("CHILD_CHANGED", "child snapshot changed");
          }
          if (
            dirname(canonical) !== root.canonicalPath ||
            basename(canonical) !== name
          ) {
            throw new ConfinedIoError(
              "CHILD_OUTSIDE_ROOT",
              `child resolves outside its root: ${path}`,
            );
          }
        } catch (cause) {
          if (cause instanceof ConfinedIoError || !isChildReplacementError(cause)) throw cause;
          throw new ConfinedIoError(
            "CHILD_CHANGED",
            `child changed during I/O: ${path}`,
            { cause },
          );
        }
        await root.verify();
      },
    };
    await file.verify();
    await hooks.afterCandidateOpen?.(join(root.path, name));
    return await operation(file);
  } finally {
    await handle.close();
  }
}

export async function readConfinedFile(file: ConfinedFile): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(Number(file.snapshot.size));
  let offset = 0;
  await scanConfinedFile(file, (chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return bytes;
}

function isChildReplacementError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function assertPrivateChildPath(path: string, policy: ConfinedIoPolicy): void {
  try {
    verifyPrivatePath(path, "file", policy);
  } catch (cause) {
    if (cause instanceof ConfinedIoError) throw cause;
    throw new ConfinedIoError(
      "CHILD_UNSAFE",
      `child does not have the required private ACL: ${path}`,
      { cause },
    );
  }
}

export async function scanConfinedFile(
  file: ConfinedFile,
  acceptChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  await file.verify();
  const expectedBytes = Number(file.snapshot.size);
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, expectedBytes + 1));
  let offset = 0;
  while (true) {
    const { bytesRead } = await file.handle.read(
      buffer,
      0,
      Math.min(buffer.byteLength, expectedBytes - offset + 1),
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
    if (offset > expectedBytes) {
      throw new ConfinedIoError(
        "CHILD_CHANGED",
        `child grew while reading: ${file.path}`,
      );
    }
    acceptChunk(buffer.subarray(0, bytesRead));
  }
  if (offset !== expectedBytes) {
    throw new ConfinedIoError(
      "CHILD_CHANGED",
      `child shrank while reading: ${file.path}`,
    );
  }
  await file.verify();
}

export function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export const sameSnapshot = sameStats;

export function safePrivateDirectory(stats: BigIntStats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink() && privateFileMode(stats);
}

function privateFileMode(stats: BigIntStats): boolean {
  return process.platform === "win32" || (stats.mode & 0o077n) === 0n;
}

export function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
}

function assertDirectory(stats: BigIntStats, policy: ConfinedIoPolicy): void {
  if (
    !stats.isDirectory() || stats.isSymbolicLink() ||
    (policy.privateDirectory && !privateFileMode(stats))
  ) {
    throw new ConfinedIoError("ROOT_UNSAFE", "root must be a real directory with the required privacy");
  }
}

function assertRegularFile(stats: BigIntStats, policy: ConfinedIoPolicy): void {
  if (
    !stats.isFile() || stats.isSymbolicLink() ||
    (policy.hardLinks === "reject" && stats.nlink !== 1n) ||
    (policy.privateFile && !privateFileMode(stats))
  ) {
    throw new ConfinedIoError("CHILD_UNSAFE", "child must be a regular file with the required privacy and link count");
  }
}

function assertByteLength(
  stats: BigIntStats,
  limits: { readonly maximumBytes: number; readonly expectedBytes?: number },
): void {
  if (stats.size < 0n || stats.size > BigInt(limits.maximumBytes)) {
    throw new ConfinedIoError("CHILD_TOO_LARGE", `child exceeds ${limits.maximumBytes} bytes`);
  }
  if (limits.expectedBytes !== undefined && stats.size !== BigInt(limits.expectedBytes)) {
    throw new ConfinedIoError("CHILD_CHANGED", "child length does not match its expected bytes");
  }
}

function verifyPrivatePath(
  path: string,
  role: "directory" | "file",
  policy: ConfinedIoPolicy,
): void {
  if (process.platform !== "win32") return;
  const required = role === "directory" ? policy.privateDirectory : policy.privateFile;
  if (!required) return;
  if (policy.verifyWindowsPrivatePath === undefined) {
    throw new ConfinedIoError("DESCRIPTOR_UNSUPPORTED", "private Windows I/O requires an ACL verifier");
  }
  policy.verifyWindowsPrivatePath(path, role);
}

function allowsPathFallback(policy: ConfinedIoPolicy): boolean {
  return policy.unavailableAlias === "identity-checked-path" ||
    (policy.unavailableAlias === "windows-private-path" && process.platform === "win32" &&
      policy.privateDirectory && policy.verifyWindowsPrivatePath !== undefined);
}

async function descriptorDirectoryPath(
  handle: FileHandle,
  canonicalRoot: string,
  snapshot: BigIntStats,
): Promise<string | undefined> {
  const candidates =
    process.platform === "linux"
      ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
      : [`/dev/fd/${handle.fd}`];
  for (const candidate of candidates) {
    try {
      const [canonical, traversed] = await Promise.all([
        realpath(candidate),
        lstat(`${candidate}/.`, { bigint: true }),
      ]);
      if (
        canonical === canonicalRoot &&
        traversed.isDirectory() &&
        sameIdentity(snapshot, traversed)
      ) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}
