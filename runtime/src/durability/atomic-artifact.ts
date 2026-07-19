/** Crash-safe, immutable publication for content artifacts. */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { lstat, link, open, readdir, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";

import { hitM4DurabilityFailpoint } from "./failpoints.js";

export type AtomicArtifactCommitResult = "committed" | "already_committed";

export class AtomicArtifactConflictError extends Error {
  readonly code = "ARTIFACT_CONTENT_CONFLICT" as const;
  readonly targetPath: string;

  constructor(targetPath: string) {
    super(`artifact target already contains different bytes: ${targetPath}`);
    this.name = "AtomicArtifactConflictError";
    this.targetPath = targetPath;
  }
}

export class AtomicArtifactUnsafePathError extends Error {
  readonly code = "ARTIFACT_UNSAFE_PARENT" as const;
  readonly targetPath: string;
  readonly parentPath: string;

  constructor(targetPath: string, parentPath: string) {
    super(`artifact target has an unsafe parent path: ${parentPath}`);
    this.name = "AtomicArtifactUnsafePathError";
    this.targetPath = targetPath;
    this.parentPath = parentPath;
  }
}

export class AtomicArtifactOperationUnsupportedError extends Error {
  readonly code = "ARTIFACT_SAFE_OPERATION_UNSUPPORTED" as const;

  constructor(
    operation: "commit" | "cleanup" | "observe",
    trustedRoot: string,
  ) {
    super(
      `safe atomic artifact ${operation} is unsupported for trusted root: ${trustedRoot}`,
    );
    this.name = "AtomicArtifactOperationUnsupportedError";
  }
}

export interface AtomicArtifactCommitOptions {
  /** Existing directory that owns this exact, immediate-child artifact. */
  readonly trustedRoot: string;
  readonly mode?: number;
}

export interface AtomicArtifactCleanupOptions {
  /** Existing directory that owns this exact, immediate-child artifact. */
  readonly trustedRoot: string;
  readonly maxDeletes?: number;
}

export interface OrphanedArtifactTempCleanupResult {
  readonly removedCount: number;
  /** More matching regular files remain because `maxDeletes` was reached. */
  readonly truncated: boolean;
}

export type AtomicArtifactObservation = "missing" | "match" | "conflict";

export interface AtomicArtifactObservationOptions {
  readonly trustedRoot: string;
  readonly cleanupOrphanedTemps?: boolean;
  readonly maxDeletes?: number;
}

type AtomicArtifactOperation =
  "commit" | "cleanup" | "cleanup_sync" | "observe";
type AtomicArtifactOperationForTesting = (operation: {
  readonly operation: AtomicArtifactOperation;
  readonly targetPath: string;
  readonly trustedRoot: string;
}) => void | Promise<void>;

let atomicArtifactOperationForTesting:
  AtomicArtifactOperationForTesting | undefined;

/** Test-only seam for deterministic trusted-root replacement races. */
export function __setAtomicArtifactOperationForTesting(
  operation: AtomicArtifactOperationForTesting | undefined,
): void {
  atomicArtifactOperationForTesting = operation;
}

/**
 * Remove abandoned temp files for one exact artifact target.
 *
 * The caller must hold exclusive ownership of the recovered run. Only regular
 * files in the target's trusted immediate parent whose names match
 * `<target-basename>.*.tmp` are eligible; symlinks, directories, and sibling
 * artifact prefixes are ignored. Deletion is bounded so corrupt/adversarial
 * directories cannot turn restart recovery into an unbounded sweep.
 */
export async function cleanupOrphanedArtifactTemps(
  targetPath: string,
  options: AtomicArtifactCleanupOptions,
): Promise<OrphanedArtifactTempCleanupResult> {
  const maxDeletes = normalizedMaxDeletes(options.maxDeletes);
  const scope = artifactScope(targetPath, options.trustedRoot);
  const pinned = await pinTrustedRoot(scope, {
    allowMissing: true,
    operation: "cleanup",
  });
  if (pinned === undefined) {
    return { removedCount: 0, truncated: false };
  }

  try {
    await assertPinnedRootCurrent(scope, pinned);
    await atomicArtifactOperationForTesting?.({
      operation: "cleanup",
      targetPath: scope.targetPath,
      trustedRoot: scope.trustedRoot,
    });
    return await cleanupPinnedArtifactTemps(scope, pinned, maxDeletes);
  } finally {
    await closePinnedRoot(pinned);
  }
}

/** Synchronous recovery-time companion to `cleanupOrphanedArtifactTemps`. */
export function cleanupOrphanedArtifactTempsSync(
  targetPath: string,
  options: AtomicArtifactCleanupOptions,
): OrphanedArtifactTempCleanupResult {
  const maxDeletes = normalizedMaxDeletes(options.maxDeletes);
  const scope = artifactScope(targetPath, options.trustedRoot);
  const pinned = pinTrustedRootSync(scope, {
    allowMissing: true,
    operation: "cleanup",
  });
  if (pinned === undefined) {
    return { removedCount: 0, truncated: false };
  }

  try {
    assertPinnedRootCurrentSync(scope, pinned);
    const hookResult = atomicArtifactOperationForTesting?.({
      operation: "cleanup_sync",
      targetPath: scope.targetPath,
      trustedRoot: scope.trustedRoot,
    });
    if (hookResult instanceof Promise) {
      throw new TypeError(
        "synchronous artifact cleanup test hook returned a promise",
      );
    }
    return cleanupPinnedArtifactTempsSync(scope, pinned, maxDeletes);
  } finally {
    closeSync(pinned.fd);
  }
}

/**
 * Observe one immutable artifact and consume that proof synchronously while
 * its trusted root remains pinned.
 *
 * The callback is intentionally synchronous: recovery can append its durable
 * journal decision before the root descriptor is released. POSIX child reads
 * and optional temp cleanup resolve through that descriptor, so swapping the
 * lexical root cannot redirect proof or deletion to an external directory.
 */
export function withAtomicArtifactObservationSync<T>(
  targetPath: string,
  expectedDigest: string,
  expectedByteLength: number,
  options: AtomicArtifactObservationOptions,
  consume: (observation: AtomicArtifactObservation) => T,
): T {
  const scope = artifactScope(targetPath, options.trustedRoot);
  if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0) {
    return consume("conflict");
  }
  const pinned = pinTrustedRootSync(scope, {
    allowMissing: true,
    operation: "observe",
  });
  if (pinned === undefined) return consume("missing");

  try {
    assertPinnedRootCurrentSync(scope, pinned);
    const hookResult = atomicArtifactOperationForTesting?.({
      operation: "observe",
      targetPath: scope.targetPath,
      trustedRoot: scope.trustedRoot,
    });
    if (hookResult instanceof Promise) {
      throw new TypeError(
        "synchronous artifact observation test hook returned a promise",
      );
    }

    const before = observePinnedArtifactSync(
      scope,
      pinned,
      expectedDigest,
      expectedByteLength,
    );
    if (
      options.cleanupOrphanedTemps === true &&
      (before.observation === "missing" || before.observation === "match")
    ) {
      cleanupPinnedArtifactTempsSync(
        scope,
        pinned,
        normalizedMaxDeletes(options.maxDeletes),
      );
    }
    assertPinnedRootCurrentSync(scope, pinned);
    const immediatelyBeforeConsume = observePinnedArtifactSync(
      scope,
      pinned,
      expectedDigest,
      expectedByteLength,
    );
    if (!sameArtifactProof(before, immediatelyBeforeConsume)) {
      throw new AtomicArtifactUnsafePathError(
        scope.targetPath,
        scope.trustedRoot,
      );
    }

    const result = consume(before.observation);
    if (result instanceof Promise) {
      throw new TypeError(
        "atomic artifact observation callback returned a promise",
      );
    }
    assertPinnedRootCurrentSync(scope, pinned);
    const afterConsume = observePinnedArtifactSync(
      scope,
      pinned,
      expectedDigest,
      expectedByteLength,
    );
    if (!sameArtifactProof(before, afterConsume)) {
      throw new AtomicArtifactUnsafePathError(
        scope.targetPath,
        scope.trustedRoot,
      );
    }
    return result;
  } finally {
    closeSync(pinned.fd);
  }
}

function normalizedMaxDeletes(value: number | undefined): number {
  const maxDeletes = value ?? 64;
  if (
    !Number.isSafeInteger(maxDeletes) ||
    maxDeletes <= 0 ||
    maxDeletes > 1_024
  ) {
    throw new TypeError("maxDeletes must be an integer between 1 and 1024");
  }
  return maxDeletes;
}

function isScopedTempName(name: string, prefix: string): boolean {
  return (
    name.startsWith(prefix) &&
    name.endsWith(".tmp") &&
    name.length > prefix.length + ".tmp".length
  );
}

/**
 * Publish immutable artifact bytes with temp + fsync + exclusive hard-link +
 * directory fsync. A same-byte replay is an idempotent acknowledgement; a
 * different-byte replay fails closed and never overwrites prior evidence.
 */
export async function commitArtifactAtomically(
  targetPath: string,
  bytes: string | Uint8Array,
  options: AtomicArtifactCommitOptions,
): Promise<AtomicArtifactCommitResult> {
  const scope = artifactScope(targetPath, options.trustedRoot);
  const pinned = await pinTrustedRoot(scope, {
    allowMissing: false,
    operation: "commit",
  });
  if (pinned === undefined) {
    throw new AtomicArtifactUnsafePathError(
      scope.targetPath,
      scope.trustedRoot,
    );
  }

  const tempName = `${scope.targetName}.${process.pid}.${randomUUID()}.tmp`;
  const tempPath = join(pinned.operationPath, tempName);
  const pinnedTargetPath = join(pinned.operationPath, scope.targetName);
  const expected =
    typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  let tempExists = false;
  try {
    await assertPinnedRootCurrent(scope, pinned);
    await atomicArtifactOperationForTesting?.({
      operation: "commit",
      targetPath: scope.targetPath,
      trustedRoot: scope.trustedRoot,
    });

    const handle = await open(
      tempPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        noFollowFlag(),
      options.mode ?? 0o600,
    );
    tempExists = true;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) {
        throw new AtomicArtifactUnsafePathError(
          scope.targetPath,
          scope.trustedRoot,
        );
      }
      await handle.writeFile(expected);
      await handle.sync();
      const afterWrite = await handle.stat();
      if (!isSameIdentity(opened, afterWrite) || afterWrite.nlink !== 1) {
        throw new AtomicArtifactUnsafePathError(
          scope.targetPath,
          scope.trustedRoot,
        );
      }
    } finally {
      await handle.close();
    }

    await assertPinnedRootCurrent(scope, pinned);
    hitM4DurabilityFailpoint("before_artifact_commit");
    let outcome: AtomicArtifactCommitResult = "committed";
    try {
      // link() is an atomic no-replace publication on the same filesystem.
      // Unlike rename(), it cannot silently overwrite immutable evidence.
      await link(tempPath, pinnedTargetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readExistingRegularFile(pinnedTargetPath);
      if (existing === undefined || !existing.equals(expected)) {
        throw new AtomicArtifactConflictError(scope.targetPath);
      }
      outcome = "already_committed";
    }

    await unlink(tempPath);
    tempExists = false;
    // This fsync belongs to both outcomes. In a concurrent same-byte race, the
    // process that observed EEXIST may reach acknowledgement before the process
    // that created the link; syncing here makes that answer independently
    // durable rather than relying on the winner's next step.
    await fsyncPinnedRoot(pinned);
    await assertPinnedRootCurrent(scope, pinned);
    hitM4DurabilityFailpoint("after_artifact_commit");
    return outcome;
  } finally {
    if (tempExists) {
      try {
        await unlink(tempPath);
      } catch {
        // The durable target, if published, is independent of the temp link.
      }
    }
    await closePinnedRoot(pinned);
  }
}

interface ArtifactScope {
  readonly targetPath: string;
  readonly targetName: string;
  readonly trustedRoot: string;
}

function artifactScope(targetPath: string, trustedRoot: string): ArtifactScope {
  if (typeof trustedRoot !== "string" || trustedRoot.length === 0) {
    throw new TypeError("artifact trustedRoot must be a non-empty path");
  }
  const resolvedTarget = resolve(targetPath);
  const resolvedRoot = resolve(trustedRoot);
  const targetName = basename(resolvedTarget);
  if (
    targetName.length === 0 ||
    targetName === "." ||
    targetName === ".." ||
    relative(resolvedRoot, dirname(resolvedTarget)) !== ""
  ) {
    throw new AtomicArtifactUnsafePathError(resolvedTarget, resolvedRoot);
  }
  return {
    targetPath: resolvedTarget,
    targetName,
    trustedRoot: resolvedRoot,
  };
}

type AsyncDirectoryHandle = Awaited<ReturnType<typeof open>>;
interface PinnedTrustedRoot {
  readonly canonicalPath: string;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly handle: AsyncDirectoryHandle;
  readonly operationPath: string;
}

interface PinnedTrustedRootSync {
  readonly canonicalPath: string;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly fd: number;
  readonly operationPath: string;
}

function isSameIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function noFollowFlag(): number {
  return (
    (fsConstants as typeof fsConstants & { readonly O_NOFOLLOW?: number })
      .O_NOFOLLOW ?? 0
  );
}

function directoryOpenFlags(): number {
  const directory =
    (fsConstants as typeof fsConstants & { readonly O_DIRECTORY?: number })
      .O_DIRECTORY ?? 0;
  return fsConstants.O_RDONLY | directory | noFollowFlag();
}

function descriptorPaths(fd: number): readonly string[] {
  if (process.platform === "linux") {
    return [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`];
  }
  if (process.platform !== "win32") return [`/dev/fd/${fd}`];
  return [];
}

async function descriptorOperationPath(
  handle: AsyncDirectoryHandle,
  canonicalPath: string,
): Promise<string | undefined> {
  for (const candidate of descriptorPaths(handle.fd)) {
    try {
      if ((await realpath(candidate)) === canonicalPath) return candidate;
    } catch {
      // Optional descriptor aliases are probed below; an unavailable alias is
      // not permission to fall back to a racy POSIX pathname.
    }
  }
  return undefined;
}

function descriptorOperationPathSync(
  fd: number,
  canonicalPath: string,
): string | undefined {
  for (const candidate of descriptorPaths(fd)) {
    try {
      if (realpathSync(candidate) === canonicalPath) return candidate;
    } catch {
      // See the asynchronous descriptor probe above.
    }
  }
  return undefined;
}

async function pinTrustedRoot(
  scope: ArtifactScope,
  options: {
    readonly allowMissing: boolean;
    readonly operation: "commit" | "cleanup";
  },
): Promise<PinnedTrustedRoot | undefined> {
  let lexical;
  try {
    lexical = await lstat(scope.trustedRoot);
  } catch (error) {
    if (
      options.allowMissing &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
    throw new AtomicArtifactUnsafePathError(
      scope.targetPath,
      scope.trustedRoot,
    );
  }
  const canonicalPath = await realpath(scope.trustedRoot);

  let handle: AsyncDirectoryHandle | undefined;
  try {
    try {
      handle = await open(scope.trustedRoot, directoryOpenFlags());
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !isUnsupportedWindowsDirectoryOperation(error)
      ) {
        throw error;
      }
      throw new AtomicArtifactOperationUnsupportedError(
        options.operation,
        scope.trustedRoot,
      );
    }

    const opened = await handle.stat();
    if (!opened.isDirectory() || !isSameIdentity(opened, lexical)) {
      throw new AtomicArtifactUnsafePathError(
        scope.targetPath,
        scope.trustedRoot,
      );
    }
    const descriptorPath = await descriptorOperationPath(handle, canonicalPath);
    if (descriptorPath === undefined) {
      throw new AtomicArtifactOperationUnsupportedError(
        options.operation,
        scope.trustedRoot,
      );
    }

    const pinned: PinnedTrustedRoot = {
      canonicalPath,
      dev: lexical.dev,
      ino: lexical.ino,
      handle,
      operationPath: descriptorPath,
    };
    await assertPinnedRootCurrent(scope, pinned);
    return pinned;
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

function pinTrustedRootSync(
  scope: ArtifactScope,
  options: {
    readonly allowMissing: boolean;
    readonly operation: "cleanup" | "observe";
  },
): PinnedTrustedRootSync | undefined {
  let lexical;
  try {
    lexical = lstatSync(scope.trustedRoot);
  } catch (error) {
    if (
      options.allowMissing &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
    throw new AtomicArtifactUnsafePathError(
      scope.targetPath,
      scope.trustedRoot,
    );
  }
  const canonicalPath = realpathSync(scope.trustedRoot);

  let fd: number;
  try {
    fd = openSync(scope.trustedRoot, directoryOpenFlags());
  } catch (error) {
    if (
      process.platform === "win32" &&
      isUnsupportedWindowsDirectoryOperation(error)
    ) {
      throw new AtomicArtifactOperationUnsupportedError(
        options.operation,
        scope.trustedRoot,
      );
    }
    throw error;
  }

  try {
    const opened = fstatSync(fd);
    const operationPath = descriptorOperationPathSync(fd, canonicalPath);
    if (!opened.isDirectory() || !isSameIdentity(opened, lexical)) {
      throw new AtomicArtifactUnsafePathError(
        scope.targetPath,
        scope.trustedRoot,
      );
    }
    if (operationPath === undefined) {
      throw new AtomicArtifactOperationUnsupportedError(
        options.operation,
        scope.trustedRoot,
      );
    }
    const pinned: PinnedTrustedRootSync = {
      canonicalPath,
      dev: lexical.dev,
      ino: lexical.ino,
      fd,
      operationPath,
    };
    assertPinnedRootCurrentSync(scope, pinned);
    return pinned;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

async function assertPinnedRootCurrent(
  scope: ArtifactScope,
  pinned: PinnedTrustedRoot,
): Promise<void> {
  try {
    const [lexical, canonical, opened] = await Promise.all([
      lstat(scope.trustedRoot),
      realpath(scope.trustedRoot),
      pinned.handle.stat(),
    ]);
    if (
      !lexical.isDirectory() ||
      lexical.isSymbolicLink() ||
      !isSameIdentity(lexical, pinned) ||
      canonical !== pinned.canonicalPath ||
      !opened.isDirectory() ||
      !isSameIdentity(opened, pinned)
    ) {
      throw new AtomicArtifactUnsafePathError(
        scope.targetPath,
        scope.trustedRoot,
      );
    }
  } catch (error) {
    if (error instanceof AtomicArtifactUnsafePathError) throw error;
    throw new AtomicArtifactUnsafePathError(
      scope.targetPath,
      scope.trustedRoot,
    );
  }
}

function assertPinnedRootCurrentSync(
  scope: ArtifactScope,
  pinned: PinnedTrustedRootSync,
): void {
  try {
    const lexical = lstatSync(scope.trustedRoot);
    const canonical = realpathSync(scope.trustedRoot);
    const opened = fstatSync(pinned.fd);
    if (
      !lexical.isDirectory() ||
      lexical.isSymbolicLink() ||
      !isSameIdentity(lexical, pinned) ||
      canonical !== pinned.canonicalPath ||
      !opened.isDirectory() ||
      !isSameIdentity(opened, pinned)
    ) {
      throw new AtomicArtifactUnsafePathError(
        scope.targetPath,
        scope.trustedRoot,
      );
    }
  } catch (error) {
    if (error instanceof AtomicArtifactUnsafePathError) throw error;
    throw new AtomicArtifactUnsafePathError(
      scope.targetPath,
      scope.trustedRoot,
    );
  }
}

async function closePinnedRoot(pinned: PinnedTrustedRoot): Promise<void> {
  await pinned.handle.close().catch(() => {});
}

async function cleanupPinnedArtifactTemps(
  scope: ArtifactScope,
  pinned: PinnedTrustedRoot,
  maxDeletes: number,
): Promise<OrphanedArtifactTempCleanupResult> {
  const prefix = `${scope.targetName}.`;
  const entries = await readdir(pinned.operationPath, { withFileTypes: true });
  let removedCount = 0;
  for (const entry of entries) {
    if (!isScopedTempName(entry.name, prefix)) continue;
    const candidate = join(pinned.operationPath, entry.name);
    let stat;
    try {
      stat = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    if (removedCount >= maxDeletes) {
      if (removedCount > 0) await fsyncPinnedRoot(pinned);
      return { removedCount, truncated: true };
    }
    try {
      await unlink(candidate);
      removedCount += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (removedCount > 0) await fsyncPinnedRoot(pinned);
  await assertPinnedRootCurrent(scope, pinned);
  return { removedCount, truncated: false };
}

function cleanupPinnedArtifactTempsSync(
  scope: ArtifactScope,
  pinned: PinnedTrustedRootSync,
  maxDeletes: number,
): OrphanedArtifactTempCleanupResult {
  const prefix = `${scope.targetName}.`;
  const entries = readdirSync(pinned.operationPath, { withFileTypes: true });
  let removedCount = 0;
  for (const entry of entries) {
    if (!isScopedTempName(entry.name, prefix)) continue;
    const candidate = join(pinned.operationPath, entry.name);
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    if (removedCount >= maxDeletes) {
      if (removedCount > 0) fsyncPinnedRootSync(pinned);
      return { removedCount, truncated: true };
    }
    try {
      unlinkSync(candidate);
      removedCount += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (removedCount > 0) fsyncPinnedRootSync(pinned);
  assertPinnedRootCurrentSync(scope, pinned);
  return { removedCount, truncated: false };
}

interface PinnedArtifactProof {
  readonly observation: AtomicArtifactObservation;
  readonly targetIdentity?: {
    readonly dev: number | bigint;
    readonly ino: number | bigint;
  };
}

function observePinnedArtifactSync(
  scope: ArtifactScope,
  pinned: PinnedTrustedRootSync,
  expectedDigest: string,
  expectedByteLength: number,
): PinnedArtifactProof {
  const targetPath = join(pinned.operationPath, scope.targetName);
  let pathStat;
  try {
    pathStat = lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { observation: "missing" };
    }
    throw error;
  }
  if (
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    pathStat.size !== expectedByteLength
  ) {
    return { observation: "conflict" };
  }

  let fd: number | undefined;
  try {
    fd = openSync(targetPath, fsConstants.O_RDONLY | noFollowFlag());
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      !isSameIdentity(opened, pathStat) ||
      opened.size !== expectedByteLength
    ) {
      return { observation: "conflict" };
    }
    const bytes = readFileSync(fd);
    const afterRead = fstatSync(fd);
    let pathAfterRead;
    try {
      pathAfterRead = lstatSync(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { observation: "conflict" };
      }
      throw error;
    }
    if (
      !afterRead.isFile() ||
      !isSameIdentity(opened, afterRead) ||
      !pathAfterRead.isFile() ||
      pathAfterRead.isSymbolicLink() ||
      !isSameIdentity(opened, pathAfterRead) ||
      bytes.byteLength !== expectedByteLength
    ) {
      return { observation: "conflict" };
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    return digest === expectedDigest
      ? {
          observation: "match",
          targetIdentity: { dev: opened.dev, ino: opened.ino },
        }
      : { observation: "conflict" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "EISDIR") {
      return { observation: "conflict" };
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sameArtifactProof(
  left: PinnedArtifactProof,
  right: PinnedArtifactProof,
): boolean {
  if (left.observation !== right.observation) return false;
  if (left.observation !== "match") return true;
  return (
    left.targetIdentity !== undefined &&
    right.targetIdentity !== undefined &&
    isSameIdentity(left.targetIdentity, right.targetIdentity)
  );
}

async function readExistingRegularFile(
  targetPath: string,
): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Reject links even on platforms that do not expose O_NOFOLLOW. POSIX then
    // also uses O_NOFOLLOW below to close the lstat/open replacement race.
    const pathStat = await lstat(targetPath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) return undefined;
    handle = await open(targetPath, fsConstants.O_RDONLY | noFollowFlag());
    const opened = await handle.stat();
    if (!opened.isFile() || !isSameIdentity(opened, pathStat)) return undefined;
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (!isSameIdentity(opened, afterRead)) return undefined;
    return bytes;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "EISDIR") {
      return undefined;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

const WINDOWS_UNSUPPORTED_DIRECTORY_CODES = new Set([
  "EBADF",
  "EISDIR",
  "EINVAL",
  "ENOTSUP",
  "EPERM",
]);

function isUnsupportedWindowsDirectoryOperation(error: unknown): boolean {
  return WINDOWS_UNSUPPORTED_DIRECTORY_CODES.has(
    (error as NodeJS.ErrnoException).code ?? "",
  );
}

async function fsyncPinnedRoot(pinned: PinnedTrustedRoot): Promise<void> {
  try {
    await pinned.handle.sync();
  } catch (error) {
    // Never hide I/O or capacity failures. Only Windows' documented lack of
    // directory-fsync support is an acceptable portable limitation.
    if (
      process.platform !== "win32" ||
      !isUnsupportedWindowsDirectoryOperation(error)
    ) {
      throw error;
    }
  }
}

function fsyncPinnedRootSync(pinned: PinnedTrustedRootSync): void {
  try {
    fsyncSync(pinned.fd);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !isUnsupportedWindowsDirectoryOperation(error)
    ) {
      throw error;
    }
  }
}
