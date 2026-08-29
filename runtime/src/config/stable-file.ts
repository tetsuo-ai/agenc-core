import {
  constants as fsConstants,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type StableFileErrorCode =
  | "identity-changed"
  | "invalid-path"
  | "not-directory"
  | "not-file"
  | "symbolic-link";

export class StableFileError extends Error {
  readonly code: StableFileErrorCode;
  readonly path: string;

  constructor(code: StableFileErrorCode, message: string, path: string) {
    super(message);
    this.name = "StableFileError";
    this.code = code;
    this.path = path;
  }
}

export interface StableFileSnapshot {
  readonly path: string;
  readonly resolvedPath: string;
  readonly bytes: Buffer;
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
  /** Lossless device/inode identity; numeric fields remain for diagnostics. */
  readonly identity: string;
}

export interface StableDirectorySnapshot {
  readonly path: string;
  readonly entries: readonly Dirent[];
  readonly dev: number;
  readonly ino: number;
}

export interface PrivateDescendantDirectory {
  /** Requested path, preserving the caller's explicit home spelling. */
  readonly path: string;
  /** Real, no-symlink path used for security-sensitive I/O. */
  readonly canonicalPath: string;
}

export function sameStableFileSnapshot(
  left: StableFileSnapshot,
  right: StableFileSnapshot,
): boolean {
  return (
    left.path === right.path &&
    left.resolvedPath === right.resolvedPath &&
    sameStableFileIdentity(left, right)
  );
}

export function sameStableFileIdentity(
  left: StableFileSnapshot,
  right: StableFileSnapshot,
): boolean {
  return (
    left.identity === right.identity &&
    left.bytes.equals(right.bytes)
  );
}

export function stableUtf8Text(
  snapshot: Pick<StableFileSnapshot, "bytes">,
  options: {
    readonly preserveBOM?: boolean;
    readonly preserveLineEndings?: boolean;
  } = {},
): string {
  let text = snapshot.bytes.toString("utf8");
  if (!options.preserveBOM && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!options.preserveLineEndings) {
    text = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  }
  return text;
}

function sameBigIntIdentity(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: Pick<BigIntStats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameBigIntContentMetadata(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    sameBigIntIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function stableError(
  code: StableFileErrorCode,
  path: string,
  detail: string,
): StableFileError {
  return new StableFileError(code, `${detail}: ${path}`, path);
}

async function lstatBigIntOrMissing(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readOpenedRegularFile(
  requestedPath: string,
  openedPath: string,
  before: BigIntStats,
): Promise<StableFileSnapshot> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(openedPath, flags).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw stableError(
        "symbolic-link",
        requestedPath,
        "configuration I/O refuses a symbolic-link target",
      );
    }
    throw error;
  });
  try {
    const opened = await handle.stat({ bigint: true });
    const afterOpen = await lstatBigIntOrMissing(openedPath);
    if (
      !opened.isFile() ||
      afterOpen === null ||
      afterOpen.isSymbolicLink() ||
      !sameBigIntIdentity(before, opened) ||
      !sameBigIntIdentity(opened, afterOpen)
    ) {
      throw stableError(
        "identity-changed",
        requestedPath,
        "configuration file changed identity while it was opened",
      );
    }

    const bytes = await handle.readFile();
    const afterRead = await handle.stat({ bigint: true });
    const afterReadPath = await lstatBigIntOrMissing(openedPath);
    if (
      afterReadPath === null ||
      afterReadPath.isSymbolicLink() ||
      !sameBigIntContentMetadata(opened, afterRead) ||
      !sameBigIntIdentity(afterRead, afterReadPath)
    ) {
      throw stableError(
        "identity-changed",
        requestedPath,
        "configuration file changed while it was read",
      );
    }

    return Object.freeze({
      path: requestedPath,
      resolvedPath: openedPath,
      bytes,
      mode: Number(opened.mode & 0o777n),
      dev: Number(opened.dev),
      ino: Number(opened.ino),
      identity: `${opened.dev}:${opened.ino}`,
    });
  } finally {
    await handle.close();
  }
}

/**
 * Read one regular file through a stable handle. The returned bytes and file
 * metadata are from the same inode; leaf-symlink replacement and path swaps
 * are rejected instead of being followed between validation and read.
 */
export async function readStableFile(
  inputPath: string,
  options: { readonly allowLeafSymlink?: boolean } = {},
): Promise<StableFileSnapshot | null> {
  const path = resolve(inputPath);
  const before = await lstatBigIntOrMissing(path);
  if (before === null) return null;
  if (!before.isSymbolicLink()) {
    if (!before.isFile()) {
      throw stableError("not-file", path, "configuration path is not a regular file");
    }
    return readOpenedRegularFile(path, path, before);
  }
  if (options.allowLeafSymlink !== true) {
    throw stableError("symbolic-link", path, "configuration I/O refuses a symbolic link");
  }

  const targetPath = await realpath(path);
  const targetBefore = await lstat(targetPath, { bigint: true });
  if (!targetBefore.isFile() || targetBefore.isSymbolicLink()) {
    throw stableError("not-file", path, "configuration symlink target is not a regular file");
  }
  const snapshot = await readOpenedRegularFile(path, targetPath, targetBefore);
  const afterLink = await lstatBigIntOrMissing(path);
  const afterTargetPath = afterLink?.isSymbolicLink()
    ? await realpath(path).catch(() => null)
    : null;
  if (
    afterLink === null ||
    !afterLink.isSymbolicLink() ||
    !sameBigIntIdentity(before, afterLink) ||
    afterTargetPath !== targetPath
  ) {
    throw stableError(
      "identity-changed",
      path,
      "configuration symlink changed while it was read",
    );
  }
  return snapshot;
}

/** Read a directory listing and reject leaf symlinks or identity swaps. */
export async function readStableDirectory(
  inputPath: string,
): Promise<StableDirectorySnapshot | null> {
  const path = resolve(inputPath);
  const before = await lstatBigIntOrMissing(path);
  if (before === null) return null;
  if (before.isSymbolicLink()) {
    throw stableError("symbolic-link", path, "configuration directory may not be a symlink");
  }
  if (!before.isDirectory()) {
    throw stableError("not-directory", path, "configuration path is not a directory");
  }
  const entries = await readdir(path, { withFileTypes: true });
  const after = await lstatBigIntOrMissing(path);
  if (
    after === null ||
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameBigIntIdentity(before, after)
  ) {
    throw stableError(
      "identity-changed",
      path,
      "configuration directory changed identity while it was listed",
    );
  }
  return Object.freeze({
    path,
    entries: Object.freeze(entries),
    dev: Number(before.dev),
    ino: Number(before.ino),
  });
}

/**
 * Reject every existing symbolic-link component above a managed file or
 * directory. Managed policy is a system authority, so following an ancestor
 * symlink would let an otherwise trusted leaf be redirected outside that
 * authority before it is opened.
 */
export async function assertNoSymlinkAncestors(inputPath: string): Promise<void> {
  const path = resolve(inputPath);
  const parent = dirname(path);
  const root = parse(parent).root;
  const remainder = relative(root, parent);
  let current = root;
  for (const segment of remainder.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstatBigIntOrMissing(current);
    if (info === null) return;
    if (info.isSymbolicLink()) {
      throw stableError(
        "symbolic-link",
        current,
        "managed configuration path contains a symbolic-link ancestor",
      );
    }
    if (!info.isDirectory()) {
      throw stableError(
        "not-directory",
        current,
        "managed configuration ancestor is not a directory",
      );
    }
  }
}

function validDescendantSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !isAbsolute(segment) &&
    !segment.includes("/") &&
    !segment.includes("\\")
  );
}

/**
 * Create a private directory below an explicit authority root without
 * following any descendant symlink. The authority root itself may be a
 * symlink (for supported relocated homes); all security-sensitive I/O uses its
 * resolved path afterward.
 */
export async function ensurePrivateDescendantDirectory(
  inputBasePath: string,
  segments: readonly string[],
): Promise<PrivateDescendantDirectory> {
  if (segments.length === 0 || segments.some((segment) => !validDescendantSegment(segment))) {
    throw stableError(
      "invalid-path",
      resolve(inputBasePath, ...segments),
      "invalid private directory path",
    );
  }
  const basePath = resolve(inputBasePath);
  await mkdir(basePath, { recursive: true, mode: 0o700 });
  const canonicalBase = await realpath(basePath);
  const directoryFlags = fsConstants.O_RDONLY |
    (fsConstants.O_DIRECTORY ?? 0) |
    (fsConstants.O_NOFOLLOW ?? 0);
  let canonicalPath = canonicalBase;
  for (const segment of segments) {
    canonicalPath = join(canonicalPath, segment);
    let info = await lstatBigIntOrMissing(canonicalPath);
    if (info === null) {
      try {
        await mkdir(canonicalPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      info = await lstatBigIntOrMissing(canonicalPath);
    }
    if (info === null || info.isSymbolicLink()) {
      throw stableError(
        "symbolic-link",
        canonicalPath,
        "private directory path contains a symbolic link",
      );
    }
    if (!info.isDirectory()) {
      throw stableError(
        "not-directory",
        canonicalPath,
        "private directory path component is not a directory",
      );
    }
    const handle = await open(canonicalPath, directoryFlags);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isDirectory() || !sameBigIntIdentity(info, opened)) {
        throw stableError(
          "identity-changed",
          canonicalPath,
          "private directory changed identity while it was secured",
        );
      }
      await handle.chmod(0o700);
      const afterChmod = await handle.stat({ bigint: true });
      const afterPath = await lstatBigIntOrMissing(canonicalPath);
      if (
        afterPath === null ||
        afterPath.isSymbolicLink() ||
        !sameBigIntIdentity(opened, afterChmod) ||
        !sameBigIntIdentity(afterChmod, afterPath)
      ) {
        throw stableError(
          "identity-changed",
          canonicalPath,
          "private directory changed identity while permissions were set",
        );
      }
    } finally {
      await handle.close();
    }
  }
  const actual = await realpath(canonicalPath);
  const descendant = relative(canonicalBase, actual);
  if (
    actual !== canonicalPath ||
    descendant.length === 0 ||
    descendant === ".." ||
    descendant.startsWith(`..${sep}`) ||
    isAbsolute(descendant)
  ) {
    throw stableError(
      "invalid-path",
      canonicalPath,
      "private directory escaped its authority root",
    );
  }

  return Object.freeze({
    path: resolve(basePath, ...segments),
    canonicalPath: actual,
  });
}
