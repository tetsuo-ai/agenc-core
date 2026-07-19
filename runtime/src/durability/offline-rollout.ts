import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { SessionLock } from "../session/session-store.js";

export class OfflineRolloutSourceMissingError extends Error {
  constructor(sourcePath: string) {
    super(`offline canonical rollout is missing: ${sourcePath}`);
    this.name = "OfflineRolloutSourceMissingError";
  }
}

export class OfflineRolloutUnsafePathError extends Error {
  constructor(sourcePath: string, detail: string) {
    super(`unsafe offline canonical rollout ${sourcePath}: ${detail}`);
    this.name = "OfflineRolloutUnsafePathError";
  }
}

export interface PinnedOfflineRollout {
  readonly sourcePath: string;
  /** Current metadata read from the retained source descriptor. */
  stat(): { readonly size: number; readonly mtimeMs: number };
  /** Read the complete repaired rollout through the retained source fd. */
  readUtf8(): string;
  /** Append one or more complete JSONL records and fsync before returning. */
  appendAndSync(content: string): void;
  /** Re-establish an fsync proof without appending duplicate evidence. */
  sync(): void;
}

/**
 * Mutate a stopped canonical rollout without reopening any trusted object by
 * pathname. The exact project/root/session directory chain and source inode
 * remain pinned across lease acquisition, tail repair, read, append, and
 * fsync. Path replacement therefore fails closed without redirecting writes.
 */
export function withPinnedOfflineRolloutLease<T>(
  options: {
    readonly projectDir: string;
    readonly sessionId: string;
    readonly sourcePath: string;
  },
  operation: (rollout: PinnedOfflineRollout) => T,
): T {
  const scope = offlineRolloutScope(options);
  const pinned = pinOfflineRollout(scope);
  const lockPath = join(
    pinned.sessionDirectory.operationPath,
    `${scope.sourceName}.lock`,
  );
  const lock = new SessionLock(lockPath);
  let fd: number | undefined;
  try {
    assertNotHeldByCurrentProcess(lockPath, scope.sourcePath);
    lock.acquire();
    assertPinnedDirectoriesCurrent(scope, pinned);
    assertSourcePathIdentity(scope, pinned, pinned.sourceIdentity);
    fd = openSync(
      join(pinned.sessionDirectory.operationPath, scope.sourceName),
      fsConstants.O_RDWR | fsConstants.O_APPEND | noFollowFlag(),
    );
    assertOpenSourceIdentity(scope, pinned, fd);
    truncateCorruptTailOnDescriptor(fd);
    assertOpenSourceIdentity(scope, pinned, fd);

    const sourceFd = fd;
    const rollout: PinnedOfflineRollout = {
      sourcePath: scope.sourcePath,
      stat: () => {
        assertOpenSourceIdentity(scope, pinned, sourceFd);
        const current = fstatSync(sourceFd);
        return { size: current.size, mtimeMs: current.mtimeMs };
      },
      readUtf8: () => {
        assertOpenSourceIdentity(scope, pinned, sourceFd);
        const raw = readDescriptorUtf8(sourceFd);
        assertOpenSourceIdentity(scope, pinned, sourceFd);
        return raw;
      },
      appendAndSync: (content) => {
        assertOpenSourceIdentity(scope, pinned, sourceFd);
        appendAndSync(sourceFd, content, scope.sourcePath);
        assertOpenSourceIdentity(scope, pinned, sourceFd);
      },
      sync: () => {
        assertOpenSourceIdentity(scope, pinned, sourceFd);
        fsyncSync(sourceFd);
        assertOpenSourceIdentity(scope, pinned, sourceFd);
      },
    };
    return operation(rollout);
  } finally {
    if (fd !== undefined) closeSync(fd);
    lock.release();
    closePinnedOfflineRollout(pinned);
  }
}

interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface OfflineRolloutScope {
  readonly projectDir: string;
  readonly journalRoot: string;
  readonly sessionDirectory: string;
  readonly sourcePath: string;
  readonly sourceName: string;
}

interface PinnedDirectory extends FileIdentity {
  readonly path: string;
  readonly canonicalPath: string;
  readonly fd: number;
  readonly operationPath: string;
}

interface PinnedOfflineRolloutState {
  readonly projectDirectory: PinnedDirectory;
  readonly journalRoot: PinnedDirectory;
  readonly sessionDirectory: PinnedDirectory;
  readonly sourceIdentity: FileIdentity;
}

function offlineRolloutScope(options: {
  readonly projectDir: string;
  readonly sessionId: string;
  readonly sourcePath: string;
}): OfflineRolloutScope {
  const resolvedProject = resolve(options.projectDir);
  const resolvedSource = resolve(options.sourcePath);
  const sourceName = basename(resolvedSource);
  if (
    !isAbsolute(options.sourcePath) ||
    options.sourcePath !== resolvedSource ||
    basename(options.sessionId) !== options.sessionId ||
    options.sessionId.length === 0 ||
    sourceName !== basename(options.sourcePath) ||
    !sourceName.startsWith("rollout-") ||
    !sourceName.endsWith(".jsonl")
  ) {
    throw new OfflineRolloutUnsafePathError(
      options.sourcePath,
      "path is not an exact canonical rollout path",
    );
  }
  for (const rootName of ["sessions", "archived_sessions"] as const) {
    const journalRoot = join(resolvedProject, rootName);
    const sessionDirectory = join(journalRoot, options.sessionId);
    if (dirname(resolvedSource) === sessionDirectory) {
      return {
        projectDir: resolvedProject,
        journalRoot,
        sessionDirectory,
        sourcePath: resolvedSource,
        sourceName,
      };
    }
  }
  throw new OfflineRolloutUnsafePathError(
    options.sourcePath,
    "path is outside this project's sessions/archived_sessions roots",
  );
}

function pinOfflineRollout(
  scope: OfflineRolloutScope,
): PinnedOfflineRolloutState {
  const opened: PinnedDirectory[] = [];
  try {
    const projectDirectory = pinDirectory(scope.projectDir);
    opened.push(projectDirectory);
    const journalRoot = pinDirectory(
      scope.journalRoot,
      projectDirectory,
      basename(scope.journalRoot),
    );
    opened.push(journalRoot);
    const sessionDirectory = pinDirectory(
      scope.sessionDirectory,
      journalRoot,
      basename(scope.sessionDirectory),
    );
    opened.push(sessionDirectory);
    const sourceIdentity = requireRegularSource(
      scope,
      join(sessionDirectory.operationPath, scope.sourceName),
    );
    const pinned = {
      projectDirectory,
      journalRoot,
      sessionDirectory,
      sourceIdentity,
    };
    assertPinnedDirectoriesCurrent(scope, pinned);
    assertSourcePathIdentity(scope, pinned, sourceIdentity);
    return pinned;
  } catch (error) {
    for (const directory of opened.reverse()) closeSync(directory.fd);
    throw error;
  }
}

function pinDirectory(
  path: string,
  parent?: PinnedDirectory,
  childName?: string,
): PinnedDirectory {
  let lexical;
  try {
    lexical = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OfflineRolloutSourceMissingError(path);
    }
    throw error;
  }
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
    throw new OfflineRolloutUnsafePathError(path, "directory is not trusted");
  }
  const openPath =
    parent === undefined
      ? path
      : join(parent.operationPath, childName ?? basename(path));
  const fd = openSync(openPath, directoryOpenFlags());
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || !sameIdentity(opened, lexical)) {
      throw new OfflineRolloutUnsafePathError(
        path,
        "directory changed while it was opened",
      );
    }
    const canonicalPath = realpathSync(path);
    const operationPath = descriptorOperationPath(fd, canonicalPath);
    if (operationPath === undefined) {
      throw new OfflineRolloutUnsafePathError(
        path,
        "platform has no descriptor-relative directory path",
      );
    }
    return {
      path,
      canonicalPath,
      dev: opened.dev,
      ino: opened.ino,
      fd,
      operationPath,
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function requireRegularSource(
  scope: OfflineRolloutScope,
  operationPath: string,
): FileIdentity {
  let source;
  try {
    source = lstatSync(operationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OfflineRolloutSourceMissingError(scope.sourcePath);
    }
    throw error;
  }
  if (!source.isFile() || source.isSymbolicLink() || source.nlink !== 1) {
    throw new OfflineRolloutUnsafePathError(
      scope.sourcePath,
      "source must be one regular, non-linked file",
    );
  }
  return { dev: source.dev, ino: source.ino };
}

function assertPinnedDirectoriesCurrent(
  scope: OfflineRolloutScope,
  pinned: PinnedOfflineRolloutState,
): void {
  for (const directory of [
    pinned.projectDirectory,
    pinned.journalRoot,
    pinned.sessionDirectory,
  ]) {
    try {
      const lexical = lstatSync(directory.path);
      const opened = fstatSync(directory.fd);
      if (
        !lexical.isDirectory() ||
        lexical.isSymbolicLink() ||
        !opened.isDirectory() ||
        !sameIdentity(lexical, directory) ||
        !sameIdentity(opened, directory) ||
        realpathSync(directory.path) !== directory.canonicalPath
      ) {
        throw new Error("identity changed");
      }
    } catch {
      throw new OfflineRolloutUnsafePathError(
        scope.sourcePath,
        `directory changed during offline mutation: ${directory.path}`,
      );
    }
  }
}

function assertSourcePathIdentity(
  scope: OfflineRolloutScope,
  pinned: PinnedOfflineRolloutState,
  expected: FileIdentity,
): void {
  try {
    const absolute = lstatSync(scope.sourcePath);
    const descriptorRelative = lstatSync(
      join(pinned.sessionDirectory.operationPath, scope.sourceName),
    );
    if (
      !absolute.isFile() ||
      absolute.isSymbolicLink() ||
      absolute.nlink !== 1 ||
      !descriptorRelative.isFile() ||
      descriptorRelative.isSymbolicLink() ||
      descriptorRelative.nlink !== 1 ||
      !sameIdentity(absolute, expected) ||
      !sameIdentity(descriptorRelative, expected)
    ) {
      throw new Error("identity changed");
    }
  } catch {
    throw new OfflineRolloutUnsafePathError(
      scope.sourcePath,
      "source changed during offline mutation",
    );
  }
}

function assertOpenSourceIdentity(
  scope: OfflineRolloutScope,
  pinned: PinnedOfflineRolloutState,
  fd: number,
): void {
  assertPinnedDirectoriesCurrent(scope, pinned);
  assertSourcePathIdentity(scope, pinned, pinned.sourceIdentity);
  const opened = fstatSync(fd);
  if (
    !opened.isFile() ||
    opened.nlink !== 1 ||
    !sameIdentity(opened, pinned.sourceIdentity)
  ) {
    throw new OfflineRolloutUnsafePathError(
      scope.sourcePath,
      "opened source identity changed during offline mutation",
    );
  }
}

function closePinnedOfflineRollout(pinned: PinnedOfflineRolloutState): void {
  closeSync(pinned.sessionDirectory.fd);
  closeSync(pinned.journalRoot.fd);
  closeSync(pinned.projectDirectory.fd);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function noFollowFlag(): number {
  return (
    (fsConstants as typeof fsConstants & { readonly O_NOFOLLOW?: number })
      .O_NOFOLLOW ?? 0
  );
}

function directoryOpenFlags(): number {
  return (
    fsConstants.O_RDONLY |
    ((fsConstants as typeof fsConstants & { readonly O_DIRECTORY?: number })
      .O_DIRECTORY ?? 0) |
    noFollowFlag()
  );
}

function descriptorOperationPath(
  fd: number,
  canonicalPath: string,
): string | undefined {
  const candidates =
    process.platform === "linux"
      ? [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]
      : process.platform === "win32"
        ? []
        : [`/dev/fd/${fd}`];
  for (const candidate of candidates) {
    try {
      if (realpathSync(candidate) === canonicalPath) return candidate;
    } catch {
      // Absence of a descriptor alias is not permission to fall back to a
      // pathname that can be replaced during offline mutation.
    }
  }
  return undefined;
}

function truncateCorruptTailOnDescriptor(fd: number): void {
  const stat = fstatSync(fd);
  if (stat.size === 0) return;
  const chunkSize = 1024 * 1024;
  let cursor = stat.size;
  let committedSize = 0;
  while (cursor > 0) {
    const length = Math.min(chunkSize, cursor);
    const position = cursor - length;
    const buffer = Buffer.allocUnsafe(length);
    readDescriptorBytes(fd, buffer, position);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline !== -1) {
      committedSize = position + lastNewline + 1;
      break;
    }
    cursor = position;
  }
  if (committedSize === stat.size) return;
  ftruncateSync(fd, committedSize);
  fsyncSync(fd);
}

function readDescriptorUtf8(fd: number): string {
  const size = fstatSync(fd).size;
  const bytes = Buffer.alloc(size);
  readDescriptorBytes(fd, bytes, 0);
  return bytes.toString("utf8");
}

function readDescriptorBytes(
  fd: number,
  bytes: Buffer,
  position: number,
): void {
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(
      fd,
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );
    if (read <= 0) {
      throw new Error("failed to read complete offline canonical rollout");
    }
    offset += read;
  }
}

function appendAndSync(fd: number, content: string, sourcePath: string): void {
  const bytes = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw new Error(`failed to append offline canonical rollout ${sourcePath}`);
    }
    offset += written;
  }
  fsyncSync(fd);
}

function assertNotHeldByCurrentProcess(
  lockPath: string,
  sourcePath: string,
): void {
  if (!existsSync(lockPath)) return;
  try {
    const lockStat = lstatSync(lockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.nlink !== 1) {
      throw new OfflineRolloutUnsafePathError(
        sourcePath,
        "journal lease path is not a regular file",
      );
    }
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as {
      readonly pid?: unknown;
    };
    if (parsed.pid === process.pid) {
      throw new Error(
        `canonical journal is live in this process (${lockPath}); stop the session before offline mutation`,
      );
    }
  } catch (error) {
    if (error instanceof OfflineRolloutUnsafePathError) throw error;
    if (
      error instanceof Error &&
      error.message.startsWith("canonical journal is live in this process")
    ) {
      throw error;
    }
    // SessionLock performs the authoritative stale/unreadable lock handling.
  }
}
