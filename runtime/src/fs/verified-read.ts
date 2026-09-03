/**
 * Descriptor-bound filesystem primitives shared by every reader that must
 * serve bytes from a *proven* location inside a root, not from a pathname it
 * resolved twice.
 *
 * The problem these solve: `lstat(p)` and `realpath(p)` are two independent
 * resolutions of the same name. An attacker with write access to the workspace
 * can flip an ancestor directory between them, so the identity check lands on
 * an out-of-scope inode while the containment check lands on an in-scope
 * pathname. The two proofs then describe different files, and a reader that
 * trusts both serves out-of-scope bytes under an in-scope path.
 *
 * The fix is to bind containment to an opened root descriptor:
 *
 *   1. `bindVerifiedRoot` opens the root directory with `O_NOFOLLOW`, proves
 *      the opened object is the one the path named, and retains the handle.
 *   2. `verifyParentChain` walks every parent segment from that handle's
 *      descriptor path, rejects symlinked or non-directory ancestors, requires
 *      each ancestor's canonical path to sit inside the root's canonical path,
 *      and re-proves the root handle against the retained binding.
 *   3. `openVerifiedCandidate` opens the final component with `O_NOFOLLOW`
 *      and proves the opened object against the path stat. What it then does
 *      about containment differs by platform, and the docstring on that
 *      function says which half is load-bearing where.
 *   4. `assertCandidateUnchanged` re-proves the object after the bytes are read.
 *
 * Directories and files are proven on different fields, deliberately. A
 * candidate FILE is proven on the full `sameStats` identity, because `size`,
 * `mtime`, and `ctime` are what detect a content swap under a retained
 * handle. A DIRECTORY is proven on `sameDirectoryIdentity` — `dev`, `ino`,
 * `mode` — because a directory's `size`, `mtime`, and `ctime` move whenever
 * any child is added, removed, or renamed. Requiring those to stand still was
 * not stricter containment, it was an availability collapse: measured under
 * purely benign sibling churn with no attacker, an MCP skill listing survived
 * 112 of 172,076 attempts. What an ancestor swap must do is make the retained
 * handle and the pathname name different objects, and `dev`/`ino` is exactly
 * the pair that catches that.
 *
 * That number is the SKILL listing, and only the skill listing. The MCP
 * MEMORY listing runs through `runtime/src/memory/scan.ts`, which has
 * directory proofs of its own and was still comparing the full identity in
 * all three of them; narrowing this file did nothing for it. Re-measured with
 * one separate process writing and removing a single sibling file, the three
 * heads run back to back:
 *
 *   surface   before this file was narrowed   after   after scan.ts too
 *   skills    102/116,343 = 0.09%             100.00%  100.00%
 *   memory     50/139,285 = 0.04%               0.15%  100.00%
 *
 * Controls, both surfaces and all three heads: no churn 100.00%, churn in a
 * directory outside the listed root 100.00%. Both surfaces are narrowed now;
 * the memory proofs and their own mutation tests live with that module.
 *
 * Platform story, and it is not uniform:
 *
 *   - linux: `/proc/self/fd/N` is a traversable, live view of an open
 *     descriptor. Every path above is descriptor-relative and
 *     `finalDescriptorPath` reads back the descriptor's true location, so
 *     containment is a *proof*: an ancestor swap cannot make an out-of-scope
 *     inode look contained.
 *   - darwin / freebsd: `/dev/fd/N` is not traversable (`opendir` returns
 *     ENOTDIR and children resolve to ENOENT), so the requested path is used
 *     and `finalDescriptorPath` degrades to an identity comparison against the
 *     expected path. Containment there is the retained root identity plus an
 *     `O_NOFOLLOW`, non-symlink, identity-checked walk of every segment before
 *     and after the read. That narrows an ancestor swap to a flip that must be
 *     timed against both walks; it is not the closed proof linux gets. Node
 *     exposes no root-confined open (`openat2`/`RESOLVE_BENEATH`), so this is
 *     the strongest construction available on those platforms.
 *   - everything else, Windows included: no descriptor-path mechanism at all.
 *     These helpers throw `context.unsupportedPlatform(...)` rather than
 *     silently falling back to plain pathname resolution. Callers decide
 *     whether that is fatal or a documented loss of function; none of them may
 *     answer it by reopening a validated pathname.
 *
 * @module
 */
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

/** Stat fields that together identify one filesystem object at one moment. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/** The proven location and identity of a retained root directory handle. */
export interface VerifiedRootBinding {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly identity: FileIdentity;
}

/** A root directory descriptor plus the binding it was proven against. */
export interface VerifiedRoot {
  readonly binding: VerifiedRootBinding;
  readonly handle: FileHandle;
}

/**
 * Caller-supplied error and cancellation behaviour.
 *
 * The memory scanner reports platform failures as its own scan-result kind and
 * cancels through the memory recall contract; the MCP providers have neither.
 * Passing both in keeps the primitives identical for every caller instead of
 * forking the security-critical code per consumer.
 */
export interface VerifiedReadContext {
  /** Throws the caller's own cancellation error when `signal` has fired. */
  readonly checkAborted: (signal: AbortSignal) => void;
  /** Builds the error raised on a platform without descriptor-path proofs. */
  readonly unsupportedPlatform: (message: string) => Error;
  /**
   * @internal Deterministic race seam, fired by `bindVerifiedRoot` after the
   * validating `lstat`/`realpath` and before the `open` that retains the
   * descriptor.
   *
   * That gap is the one window a root binding cannot close by construction:
   * `O_NOFOLLOW` refuses a symlinked *final* component but says nothing about
   * mid-path ones, so an attacker who repoints an ancestor here makes the
   * `open` land on a different directory than the one that was validated. The
   * two proofs that catch it — the before/opened/after identity proof and the
   * final-path proof — are what the tests reach through this hook; without a
   * seam they are only reachable by a timing race, which is why they sat
   * unpinned while a mutant that deletes them served out-of-scope bodies.
   */
  readonly beforeRootOpenForTesting?: (
    requestedPath: string,
  ) => void | Promise<void>;
}

/** Raised when the platform cannot prove where an open descriptor points. */
export class UnsupportedVerifiedReadPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedVerifiedReadPlatformError";
  }
}

/** Raised when a root directory changed identity or location while binding. */
export class VerifiedRootUnstableError extends Error {
  constructor(readonly reason: "identity" | "final-path", message: string) {
    super(message);
    this.name = "VerifiedRootUnstableError";
  }
}

/** Cancellation/error behaviour for callers with no contract of their own. */
export const DEFAULT_VERIFIED_READ_CONTEXT: VerifiedReadContext = {
  checkAborted: (signal: AbortSignal): void => {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("verified read aborted");
  },
  unsupportedPlatform: (message: string): Error =>
    new UnsupportedVerifiedReadPlatformError(message),
};

/**
 * Open flags for a verified regular-file read.
 *
 * `O_NOFOLLOW` rejects a final component swapped to a symlink and `O_NONBLOCK`
 * stops an open of a swapped-in FIFO from hanging. Both are structural: the
 * identity proofs around the open reject every *distinct* replacement on their
 * own, so these flags are what remains for a replacement that is the same
 * inode reached through another name.
 */
export function verifiedFileOpenFlags(): number {
  if (process.platform === "win32") return constants.O_RDONLY;
  return (
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0)
  );
}

/** Open flags for a verified directory handle. */
export function verifiedDirectoryOpenFlags(): number {
  if (process.platform === "win32") return constants.O_RDONLY;
  return (
    constants.O_RDONLY |
    (constants.O_DIRECTORY ?? 0) |
    (constants.O_NOFOLLOW ?? 0)
  );
}

export function identityFromStats(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

export function sameStats(
  left: BigIntStats | FileIdentity,
  right: BigIntStats | FileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Identity fields that prove two observations describe the same *directory*.
 *
 * Deliberately narrower than `sameStats`: a directory's `mtime`, `ctime`, and
 * `size` all move whenever any child is added, removed, or renamed, so a
 * directory proof that included them rejected every ordinary concurrent write
 * in the workspace. Measured under purely benign sibling churn and no
 * attacker at all, the full-identity proof left the MCP skill listing
 * available 0.09% of the time (102 of 116,343 listings) and, through the
 * separate proofs in `memory/scan.ts`, the MCP memory listing available 0.15%
 * of the time (113 of 76,583 listings); the entire listing collapsed because
 * a neighbouring file was being written.
 *
 * Containment does not need those fields. What an ancestor swap has to do is
 * make the retained handle and the pathname refer to *different* objects, and
 * `dev`/`ino` is exactly the pair that detects that; `mode` pins the object
 * type and permission bits alongside it. A directory's own timestamp
 * advancing is not a containment violation, and treating it as one traded all
 * availability for no additional proof.
 *
 * Candidate *files* keep the full `sameStats` identity, where `size`, `mtime`,
 * and `ctime` are what detect an in-place content swap.
 */
export function sameDirectoryIdentity(
  left: BigIntStats | FileIdentity,
  right: BigIntStats | FileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

/** True when `candidate` is a strict descendant of `root`. */
export function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation.length > 0 &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

/**
 * Path used to enumerate and open entries below an already-verified
 * descriptor. Linux traverses through `/proc/self/fd/N`. On darwin and
 * freebsd `/dev/fd/N` is not traversable (`opendir` fails with ENOTDIR and
 * children resolve to ENOENT), so the real requested path is used while the
 * retained descriptor, `O_NOFOLLOW`, `nlink === 1`, and the before/after
 * identity checks continue to guard against exchanges.
 */
export function descriptorHandlePath(
  handle: FileHandle,
  requestedPath: string,
  context: VerifiedReadContext,
): string {
  if (process.platform === "linux") return `/proc/self/fd/${handle.fd}`;
  if (process.platform === "darwin" || process.platform === "freebsd") {
    return requestedPath;
  }
  throw context.unsupportedPlatform(
    "descriptor-relative traversal is unavailable on this platform",
  );
}

export function descriptorRelativePath(
  root: VerifiedRoot,
  relativePath: string,
  context: VerifiedReadContext,
): string {
  const descriptorPath = descriptorHandlePath(
    root.handle,
    root.binding.requestedPath,
    context,
  );
  return relativePath.length === 0
    ? descriptorPath
    : join(descriptorPath, relativePath);
}

export function canonicalRelativePath(
  root: VerifiedRoot,
  relativePath: string,
): string {
  return relativePath.length === 0
    ? root.binding.canonicalPath
    : join(root.binding.canonicalPath, relativePath);
}

export async function closeVerifiedHandle(
  handle: FileHandle,
  signal: AbortSignal,
  context: VerifiedReadContext,
): Promise<void> {
  await handle.close().catch(() => undefined);
  context.checkAborted(signal);
}

/**
 * Open a root directory and retain the descriptor every later proof is made
 * against. Returns `null` when the directory is absent, is a symlink, is not a
 * directory, or cannot be opened; throws `VerifiedRootUnstableError` when the
 * object changed identity or location between the checks.
 */
export async function bindVerifiedRoot(
  directory: string,
  signal: AbortSignal,
  context: VerifiedReadContext,
): Promise<VerifiedRoot | null> {
  context.checkAborted(signal);
  const requestedPath = resolve(directory);
  let before: BigIntStats;
  try {
    before = await lstat(requestedPath, { bigint: true });
  } catch {
    context.checkAborted(signal);
    return null;
  }
  context.checkAborted(signal);
  if (before.isSymbolicLink() || !before.isDirectory()) return null;
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
  } catch {
    context.checkAborted(signal);
    return null;
  }
  context.checkAborted(signal);
  await context.beforeRootOpenForTesting?.(requestedPath);
  context.checkAborted(signal);
  let handle: FileHandle;
  try {
    handle = await open(requestedPath, verifiedDirectoryOpenFlags());
  } catch {
    context.checkAborted(signal);
    return null;
  }
  let retainHandle = false;
  try {
    context.checkAborted(signal);
    const opened = await handle.stat({ bigint: true });
    context.checkAborted(signal);
    const after = await lstat(requestedPath, { bigint: true });
    context.checkAborted(signal);
    // Directory identity, not full `sameStats`: `before`, `opened`, and
    // `after` are three observations taken across two awaits, so any child
    // write anywhere in this directory moved its timestamps between them.
    // What this proves is that the object the `open` landed on is the object
    // the `lstat` validated, and `dev`/`ino`/`mode` is that proof.
    if (
      !opened.isDirectory() ||
      !sameDirectoryIdentity(before, opened) ||
      !sameDirectoryIdentity(opened, after)
    ) {
      throw new VerifiedRootUnstableError(
        "identity",
        "verified root changed while binding",
      );
    }
    const finalPath = await finalDescriptorPath(
      handle,
      canonicalPath,
      signal,
      context,
    );
    if (finalPath !== canonicalPath) {
      throw new VerifiedRootUnstableError(
        "final-path",
        "verified root final path changed",
      );
    }
    retainHandle = true;
    return {
      binding: {
        requestedPath,
        canonicalPath,
        identity: identityFromStats(opened),
      },
      handle,
    };
  } finally {
    if (!retainHandle) await closeVerifiedHandle(handle, signal, context);
  }
}

/**
 * Open one candidate below a bound root, prove the opened object is the one
 * the path named, and prove it is still reachable only from inside that root.
 *
 * Be precise about which clause buys what, because the obvious reading of the
 * last step is wrong on two of the three platforms:
 *
 *   - `verifyParentChain`, called here before the open and again by every
 *     caller after the bytes are read, is what actually rejects an ancestor
 *     swap. It walks each parent segment from the retained root descriptor,
 *     refuses a symlinked or non-directory segment, requires each segment's
 *     canonical path to sit inside the root's, and re-proves the root handle.
 *   - on linux, `finalDescriptorPath` reads the descriptor's live location
 *     back out of `/proc/self/fd`, so `isContained` on that result is a real
 *     containment proof about the opened object.
 *   - on darwin and freebsd it is not. There `finalDescriptorPath` returns
 *     the very `expectedPath` it was handed — `join(canonicalPath, rel)` —
 *     or `null`, so `isContained(canonicalPath, join(canonicalPath, rel))` is
 *     a tautology for any `rel` the `isContained` pre-check already admitted.
 *     Only `canonicalPath` is symlink-free by construction; the `rel` part of
 *     that name traverses the very segments an attacker controls, the same
 *     ones the open traversed. What the call still buys on those platforms is
 *     the identity comparison inside it — the open handle against
 *     `lstat(join(canonicalPath, rel))` — which is a third resolution of the
 *     name, not a containment proof.
 *
 * Measured, in the geometry where a segment INSIDE the bound root is flipped
 * between a real directory and a symlink to an out-of-scope twin, attacker in
 * its own process, no seams: deleting the whole final-path block here forges
 * nothing (0 of 31,621 served, 53,722 attempts), and deleting the callers'
 * post-read `assertCandidateUnchanged` and ancestor re-walk on top of it
 * still forges nothing (0 of 44,394 served, 66,736 attempts). Deleting
 * `verifyParentChain` forges immediately: 56 of 40,342 served, 54,687
 * attempts. In that geometry the ancestor walk is the guard; everything after
 * the open is depth behind it.
 */
export async function openVerifiedCandidate(
  root: VerifiedRoot,
  relativePath: string,
  signal: AbortSignal,
  context: VerifiedReadContext,
): Promise<FileHandle | null> {
  context.checkAborted(signal);
  const filePath = join(root.binding.requestedPath, relativePath);
  if (!isContained(root.binding.requestedPath, filePath)) return null;
  if (!(await verifyParentChain(root, relativePath, signal, context))) {
    return null;
  }
  const descriptorPath = descriptorRelativePath(root, relativePath, context);
  let pathStats: BigIntStats;
  try {
    pathStats = await lstat(descriptorPath, { bigint: true });
  } catch {
    context.checkAborted(signal);
    return null;
  }
  context.checkAborted(signal);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) return null;
  let handle: FileHandle;
  try {
    handle = await open(descriptorPath, verifiedFileOpenFlags());
  } catch {
    context.checkAborted(signal);
    return null;
  }
  try {
    context.checkAborted(signal);
    const opened = await handle.stat({ bigint: true });
    context.checkAborted(signal);
    if (!opened.isFile() || opened.nlink !== 1n || !sameStats(pathStats, opened)) {
      await handle.close();
      context.checkAborted(signal);
      return null;
    }
    const finalPath = await finalDescriptorPath(
      handle,
      canonicalRelativePath(root, relativePath),
      signal,
      context,
    );
    if (
      finalPath === null ||
      !isContained(root.binding.canonicalPath, finalPath)
    ) {
      await handle.close();
      context.checkAborted(signal);
      return null;
    }
    const finalStats = await lstat(finalPath, { bigint: true });
    context.checkAborted(signal);
    if (!sameStats(opened, finalStats)) {
      await handle.close();
      context.checkAborted(signal);
      return null;
    }
    context.checkAborted(signal);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    context.checkAborted(signal);
    throw error;
  }
}

/**
 * Walk every parent segment from the bound root's descriptor path: each must
 * be a real, non-symlink directory whose canonical path is inside the root's
 * canonical path, and the root handle itself must still match its binding.
 */
export async function verifyParentChain(
  root: VerifiedRoot,
  relativePath: string,
  signal: AbortSignal,
  context: VerifiedReadContext,
): Promise<boolean> {
  const segments = relativePath.split(sep);
  let cursor = descriptorHandlePath(
    root.handle,
    root.binding.requestedPath,
    context,
  );
  const parentSegments = segments.slice(0, -1);
  for (const segment of parentSegments) {
    context.checkAborted(signal);
    cursor = join(cursor, segment);
    const stats = await lstat(cursor, { bigint: true });
    context.checkAborted(signal);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    const canonical = await realpath(cursor);
    context.checkAborted(signal);
    if (!isContained(root.binding.canonicalPath, canonical)) return false;
  }
  const openedRoot = await root.handle.stat({ bigint: true });
  context.checkAborted(signal);
  const currentRoot = await lstat(root.binding.requestedPath, { bigint: true });
  context.checkAborted(signal);
  // `sameDirectoryIdentity`, not `sameStats`: see its doc comment. The root
  // is re-proven on every listing and on every read, so requiring its
  // timestamps to stand still required the whole workspace to stand still.
  return (
    !currentRoot.isSymbolicLink() &&
    sameDirectoryIdentity(openedRoot, root.binding.identity) &&
    sameDirectoryIdentity(currentRoot, root.binding.identity)
  );
}

/** Re-prove an opened candidate against its path after its bytes were read. */
export async function assertCandidateUnchanged(
  handle: FileHandle,
  descriptorPath: string,
  before: FileIdentity,
  signal: AbortSignal,
  context: VerifiedReadContext,
): Promise<void> {
  context.checkAborted(signal);
  const openedAfter = identityFromStats(await handle.stat({ bigint: true }));
  context.checkAborted(signal);
  const pathAfter = identityFromStats(
    await lstat(descriptorPath, { bigint: true }),
  );
  context.checkAborted(signal);
  if (!sameStats(before, openedAfter) || !sameStats(before, pathAfter)) {
    throw new Error("verified candidate changed during descriptor-bound read");
  }
}

/**
 * Resolve the path an open descriptor currently refers to, or `null` when it
 * can no longer be proven to sit at `expectedPath`.
 *
 * Linux exposes the live target through `/proc/self/fd/N`. darwin and freebsd
 * do not: `realpath("/dev/fd/N")` yields `/dev/fd/<basename>` instead of the
 * target, so a string comparison against the canonical path can never match
 * and every recall root used to fail closed. Those platforms instead prove the
 * descriptor identity (dev/ino/mode/size/mtime/ctime) against `expectedPath`,
 * which is the property the alias comparison was buying.
 */
export async function finalDescriptorPath(
  handle: FileHandle,
  expectedPath: string,
  signal: AbortSignal,
  context: VerifiedReadContext,
): Promise<string | null> {
  if (process.platform === "linux") {
    const path = await realpath(`/proc/self/fd/${handle.fd}`);
    context.checkAborted(signal);
    return path;
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    const opened = await handle.stat({ bigint: true });
    context.checkAborted(signal);
    let expected: BigIntStats;
    try {
      expected = await lstat(expectedPath, { bigint: true });
    } catch {
      context.checkAborted(signal);
      return null;
    }
    context.checkAborted(signal);
    if (expected.isSymbolicLink()) return null;
    // Directories are compared on `dev`/`ino`/`mode` for the reason given on
    // `sameDirectoryIdentity`; every caller that hands a directory here
    // separately proves the handle against its retained binding. Regular
    // files keep the full identity, which is what detects a content swap.
    //
    // This branch has no deterministic test: the two observations it compares
    // are both taken inside this function, so nothing can write between them
    // on demand. It is pinned by measurement instead. Narrowing only the two
    // other directory proofs and leaving this one on `sameStats` puts the
    // benign-churn skill listing at 68.91% (24,129 of 35,016) instead of
    // 100.00%; on linux the branch is not reached at all, because there the
    // descriptor's path is read back from `/proc/self/fd`.
    const same = opened.isDirectory()
      ? expected.isDirectory() && sameDirectoryIdentity(opened, expected)
      : sameStats(opened, expected);
    return same ? expectedPath : null;
  }
  throw context.unsupportedPlatform(
    "descriptor final-path verification is unavailable on this platform",
  );
}
