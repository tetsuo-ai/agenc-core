import fs from "node:fs";
import path from "node:path";
import { canonicalAuthorityPath } from "../desktop-authority-protection.js";
import { nestedGitMetadataDirs } from "../engine/policy.js";

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
      return canonicalAuthorityPath(root);
    } catch {
      return root;
    }
  });
  const baseline = new Set<string>();
  for (const root of scanRoots) {
    try {
      for (const nested of nestedGitMetadataDirs(root)) baseline.add(nested);
    } catch {
      violation = true;
    }
  }
  const scanNestedRepos = () => {
    for (const root of scanRoots) {
      let found: string[];
      try {
        found = nestedGitMetadataDirs(root);
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
  const scan = () => {
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
    scanNestedRepos();
  };
  scan();
  const interval = setInterval(scan, PROTECTED_CREATE_POLL_MS);
  // The watched command keeps its owner alive; the poll itself never should.
  interval.unref?.();
  return {
    stop(): boolean {
      if (!stopped) {
        stopped = true;
        clearInterval(interval);
        scan();
      }
      return violation;
    },
  };
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
