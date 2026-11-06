import fs from "node:fs";
import path from "node:path";

/** How often a running command's protected-create targets are rechecked. */
export const PROTECTED_CREATE_POLL_MS = 100;

export interface ProtectedCreateMonitor {
  /**
   * Final check: removes any target that exists and reports whether one ever
   * did. Later calls report the same answer without checking again.
   */
  readonly stop: () => boolean;
}

/**
 * Created-path monitor for missing protected metadata paths that bubblewrap
 * cannot mount a placeholder over (a missing `.agenc`, `.agents` or `.git`
 * whose ancestor has one, or a narrowed `.git` carve-out). A target that
 * exists at start, at any poll or at stop is removed, and the command that
 * ran under the monitor fails. Shared by the per-command Node launcher and
 * the persistent session sandbox so both enforce the same rule.
 *
 * This runs on the host while the command runs. Targets are physical paths
 * (the planners resolve them), so no directory on the way to one is a link.
 * Every check walks to the target's parent from `/` one directory at a time
 * through descriptors, never following a link, and removes the target
 * through the descriptor of the parent it found. A rename or a link the
 * command puts in place of a directory can therefore never send a check or
 * a removal into another tree: a link where a directory is expected fails
 * the command and removes nothing.
 */
export function startProtectedCreateMonitor(
  targets: readonly string[],
  nestedGitScanRoots: readonly string[] = [],
  nestedGitBaseline?: readonly string[],
): ProtectedCreateMonitor {
  if (targets.length === 0 && nestedGitScanRoots.length === 0) {
    return { stop() { return false; } };
  }
  let violation = false;
  let stopped = false;
  const watched = targets.map(watchedTarget);
  // A target that cannot be walked to is never cleaned: fail closed.
  if (watched.some((target) => target === undefined)) violation = true;
  // A nested repository (`sub/.git`, not a `.git/modules` submodule) that is
  // already a real repository when the command starts is legitimate and
  // handled by the plan's carve-outs. Only one that APPEARS or is PROMOTED to
  // a real repository during the run is a violation: a confined command can
  // assemble a nested repo with a planted fsmonitor/hook that a later
  // host-side git would run. Snapshot the pre-existing ones so they are left
  // alone, and remove any new one through the same no-follow walk, failing
  // the command.
  const scanRoots = nestedGitScanRoots.map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return path.resolve(root);
    }
  });
  // The baseline is the real nested repositories present when the command
  // starts. The bubblewrap/Landlock plan already walked the tree to build its
  // carve-outs, so when it passes that set here the monitor does NOT walk at
  // start: the per-command walks are one in the plan and one in stop(). When
  // no baseline is supplied (e.g. a plan that did not compute it), fall back
  // to walking once here.
  const canonicalBaseline = (entry: string): string => {
    try {
      return fs.realpathSync(entry);
    } catch {
      return path.resolve(entry);
    }
  };
  const baseline = new Set<string>();
  if (nestedGitBaseline !== undefined) {
    for (const nested of nestedGitBaseline) baseline.add(canonicalBaseline(nested));
  } else {
    for (const root of scanRoots) {
      try {
        for (const nested of nestedRealGitRepos(root)) baseline.add(nested);
      } catch {
        violation = true;
      }
    }
  }
  const scanNestedRepos = () => {
    for (const root of scanRoots) {
      let found: string[];
      try {
        found = nestedRealGitRepos(root);
      } catch {
        violation = true;
        continue;
      }
      for (const nested of found) {
        if (baseline.has(nested)) continue;
        const target = watchedTarget(nested);
        if (target === undefined) { violation = true; continue; }
        try {
          checkTarget(target);
        } catch {
          // left in place on any error below
        }
        // A new real nested repository is itself the violation, whether or
        // not the removal walk reached it.
        violation = true;
      }
    }
  };
  // The top-level protected-create targets are a few fixed paths: check them
  // at start, on every poll and at stop, so a created `.git` surface is
  // removed promptly. The nested-repository walk covers the whole writable
  // tree, so it does NOT run on the poll: it runs once here (the baseline
  // above) and once in stop(), after the command's whole process tree is
  // gone. That keeps the guarantee (the command fails and the repository is
  // removed before any later host-side git can descend into it) without a
  // continuous full-tree walk for the life of every command.
  const scanTargets = () => {
    for (const target of watched) {
      if (target === undefined) continue;
      try {
        if (checkTarget(target)) violation = true;
      } catch {
        // A check or a removal that could not finish cannot prove the
        // target is gone.
        violation = true;
      }
    }
  };
  scanTargets();
  const interval = watched.length === 0
    ? undefined
    : setInterval(scanTargets, PROTECTED_CREATE_POLL_MS);
  // The watched command keeps its owner alive; the poll itself never should.
  interval?.unref?.();
  return {
    stop(): boolean {
      if (!stopped) {
        stopped = true;
        if (interval !== undefined) clearInterval(interval);
        scanTargets();
        scanNestedRepos();
      }
      return violation;
    },
  };
}

/** Bounds for the nested-repository scan, matching the sandbox policy scan. */
const NESTED_GIT_SCAN_MAX_DEPTH = 8;
const NESTED_GIT_SCAN_MAX_DIRS = 4096;

/**
 * Whether `gitDir` is a real git repository directory: a `.git` with a `HEAD`
 * file and an `objects` directory, as `git init` writes. A `.git` that is not
 * a repository is not narrowed and is no gitlink threat.
 */
function isRealGitRepository(gitDir: string): boolean {
  try {
    if (!fs.lstatSync(gitDir).isDirectory()) return false;
    return (
      fs.lstatSync(path.join(gitDir, "HEAD")).isFile() &&
      fs.lstatSync(path.join(gitDir, "objects")).isDirectory()
    );
  } catch {
    return false;
  }
}

/**
 * Real `.git` directories of standalone nested repositories under `root`,
 * excluding the root's own top-level `.git`. Bounded in depth and in
 * directories visited, never follows a symlink and never descends into a
 * `.git` (so a `.git/modules` submodule is not reported). Kept local to this
 * module so the created-path monitor pulls in nothing but `node:fs`/`node:path`
 * and can run inside the standalone launchers that load it.
 */
function nestedRealGitRepos(root: string): string[] {
  const start = path.resolve(root);
  const topLevelGit = path.join(start, ".git");
  const found: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > NESTED_GIT_SCAN_MAX_DEPTH || visited >= NESTED_GIT_SCAN_MAX_DIRS) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    visited += 1;
    for (const entry of entries) {
      if (visited >= NESTED_GIT_SCAN_MAX_DIRS) return;
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (entry.name === ".git") {
        if (child !== topLevelGit && isRealGitRepository(child)) found.push(child);
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(start, 0);
  return found;
}

interface WatchedTarget {
  /** The directories from `/` to the target's parent. */
  readonly parents: readonly string[];
  readonly leaf: string;
}

function watchedTarget(target: string): WatchedTarget | undefined {
  // Descriptor-relative paths need Linux /proc; elsewhere nothing is removed.
  if (process.platform !== "linux") return undefined;
  const parents = path.resolve(target).split(path.sep).filter(Boolean);
  const leaf = parents.pop();
  return leaf === undefined ? undefined : { parents, leaf };
}

/** Whether the target existed; an existing target is removed. */
function checkTarget(target: WatchedTarget): boolean {
  let directory = fs.openSync(path.sep, DIRECTORY_FLAGS);
  try {
    for (const name of target.parents) {
      const child = openChildDirectory(directory, name);
      // A link where a directory should be: never followed.
      if (child.kind === "link") return true;
      // Missing, or a file: the target cannot exist under it.
      if (child.kind !== "directory") return false;
      closeQuietly(directory);
      directory = child.fd;
    }
    if (!entryExists(directory, target.leaf)) return false;
    removeEntryAt(directory, target.leaf);
    return true;
  } finally {
    closeQuietly(directory);
  }
}

/** A clean exit becomes a failure when the command created a protected path. */
export function protectedCreateExitCode(exitCode: number, violation: boolean): number {
  return violation && exitCode === 0 ? 1 : exitCode;
}

/**
 * Monitors started by an in-process launcher (session sandbox, direct
 * bubblewrap) for the command a child handle represents. The owner of the
 * handle stops it only after the command's whole process tree is gone, so
 * the final check sees everything the command could have created.
 */
const attachedMonitors = new WeakMap<object, ProtectedCreateMonitor>();

export function attachProtectedCreateMonitor(
  child: object,
  monitor: ProtectedCreateMonitor,
): void {
  attachedMonitors.set(child, monitor);
}

/** Idempotent: false when no monitor is attached or it was already stopped. */
export function stopAttachedProtectedCreateMonitor(child: object): boolean {
  const monitor = attachedMonitors.get(child);
  if (monitor === undefined) return false;
  attachedMonitors.delete(child);
  return monitor.stop();
}

// Directory descriptors (Linux). A path that starts at /proc/self/fd/<fd>/ is
// looked up from the directory the descriptor holds, wherever that directory
// is now, so each step below names one entry of a directory already pinned.

/** O_PATH: a descriptor that names a directory without needing read access. */
const O_PATH = 0o10000000;
const DIRECTORY_FLAGS = O_PATH | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
/** Deeper trees fail the command instead of exhausting descriptors. */
const MAX_REMOVE_DEPTH = 256;

type ChildDirectory =
  | { readonly kind: "directory"; readonly fd: number }
  | { readonly kind: "missing" }
  | { readonly kind: "not-directory" }
  | { readonly kind: "link" };

/** `/proc/self/fd/<fd>`, or the entry `name` of that directory. */
export function descriptorPath(fd: number, name?: string | Buffer): Buffer {
  const base = Buffer.from(`/proc/self/fd/${fd}`);
  if (name === undefined) return base;
  return Buffer.concat([base, Buffer.from("/"), typeof name === "string" ? Buffer.from(name) : name]);
}

/** Open the directory entry `name` of `parent` without following a link. */
function openChildDirectory(parent: number, name: string | Buffer): ChildDirectory {
  const entry = descriptorPath(parent, name);
  const open = (): ChildDirectory => {
    try {
      return { kind: "directory", fd: fs.openSync(entry, DIRECTORY_FLAGS) };
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return { kind: "missing" };
      if (code === "ELOOP") return { kind: "link" };
      if (code !== "ENOTDIR") throw error;
    }
    // O_PATH with O_NOFOLLOW reports a link as "not a directory".
    try {
      return fs.lstatSync(entry).isSymbolicLink() ? { kind: "link" } : { kind: "not-directory" };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { kind: "missing" };
      throw error;
    }
  };
  return withOwnerAccess(parent, open);
}

function entryExists(directory: number, name: string | Buffer): boolean {
  return withOwnerAccess(directory, () => {
    try {
      fs.lstatSync(descriptorPath(directory, name));
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  });
}

/**
 * Remove the entry `name` of `directory` and, for a directory, everything in
 * it. Every directory is entered through a descriptor opened without
 * following links, so a link anywhere in the tree is removed as a link and
 * its target is never touched.
 */
export function removeEntryAt(directory: number, name: string | Buffer, depth = 0): void {
  const entry = descriptorPath(directory, name);
  const child = openChildDirectory(directory, name);
  if (child.kind === "missing") return;
  if (child.kind === "directory") {
    try {
      if (depth >= MAX_REMOVE_DEPTH) throw new Error("protected path nests too deeply to remove");
      const entries = withOwnerAccess(child.fd, () =>
        fs.readdirSync(descriptorPath(child.fd), { encoding: "buffer" }));
      for (const inner of entries) removeEntryAt(child.fd, inner, depth + 1);
    } finally {
      closeQuietly(child.fd);
    }
  }
  withOwnerAccess(directory, () => {
    try {
      if (child.kind === "directory") fs.rmdirSync(entry);
      else fs.unlinkSync(entry);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return;
      // Replaced meanwhile: a link or a file where a directory was is
      // unlinked, a directory where a link or a file was is entered again.
      if (code === "ENOTDIR") fs.unlinkSync(entry);
      else if (code === "EISDIR" && depth < MAX_REMOVE_DEPTH) removeEntryAt(directory, name, depth + 1);
      else throw error;
    }
  });
}

/**
 * Run `operation` in a directory the host user owns; when the command took
 * the owner's access away, restore the owner's access once and retry.
 */
function withOwnerAccess<T>(directory: number, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EACCES" && code !== "EPERM") throw error;
  }
  const self = descriptorPath(directory);
  fs.chmodSync(self, (fs.statSync(self).mode & 0o7777) | 0o700);
  return operation();
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // Already closed.
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
