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
  /**
   * After stop(): a message for the command's output when a nested repository
   * created during the run was moved aside, naming where each one went.
   */
  readonly notice?: () => string | undefined;
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
  // The entry's own path with only its parent resolved (never the entry
  // itself, which for a `.git` symlink would be its target): this is how the
  // stop scan spells it, so a pre-existing pointer matches its baseline entry.
  const canonicalBaseline = (entry: string): string => {
    try {
      return path.join(fs.realpathSync(path.dirname(entry)), path.basename(entry));
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
        for (const nested of nestedGitDescentPoints(root)) baseline.add(nested);
      } catch {
        violation = true;
      }
    }
  }
  // Nested repositories moved aside by the final check, for the notice.
  const outcomes: Array<
    | { readonly kind: "moved"; readonly dir: string; readonly to: string }
    | { readonly kind: "removed" | "left"; readonly dir: string }
  > = [];
  const scanNestedRepos = () => {
    for (const root of scanRoots) {
      let found: string[];
      try {
        found = nestedGitDescentPoints(root);
      } catch {
        violation = true;
        continue;
      }
      for (const nested of found) {
        if (baseline.has(nested)) continue;
        const target = watchedTarget(nested);
        if (target === undefined) { violation = true; continue; }
        // Move the new repository's `.git` aside rather than delete it: the
        // folder stops being a repository (git looks only for `.git`), so the
        // protection holds, and nothing is lost whoever made it. Only if the
        // move cannot be made is it removed instead; if neither can be done it
        // is left in place. Every outcome is reported in the notice.
        const dir = path.dirname(nested);
        try {
          const destination = moveGitAside(target);
          if (destination !== undefined) outcomes.push({ kind: "moved", dir, to: destination });
        } catch {
          try {
            if (checkTarget(target)) outcomes.push({ kind: "removed", dir });
          } catch {
            outcomes.push({ kind: "left", dir });
          }
        }
        // A new real nested repository is itself the violation, whether or
        // not the move or removal reached it.
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
    notice(): string | undefined {
      if (outcomes.length === 0) return undefined;
      // The monitor cannot tell who made the repository, so no message claims
      // it; renaming it back would reinstate its hooks and config, so the
      // message cautions first.
      return outcomes.map((outcome) => {
        const where = `agenc: a nested git repository appeared at ${outcome.dir} while this command ran`;
        switch (outcome.kind) {
          case "moved":
            return `${where}, so its .git was moved aside to ${outcome.to} and git no longer treats that folder ` +
              "as a repository. Nothing was deleted. If you made it yourself, check its hooks and config, then " +
              `rename it back to .git; otherwise delete ${outcome.to}.`;
          case "removed":
            return `${where} and could not be moved aside, so its .git was removed.`;
          case "left":
            return `${where} and could not be moved aside or removed. Check ${outcome.dir}/.git/hooks and ` +
              `${outcome.dir}/.git/config before running git there.`;
        }
      }).join("\n");
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
function nestedGitDescentPoints(root: string): string[] {
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
      const child = path.join(dir, entry.name);
      if (entry.name === ".git") {
        // A nested `.git` a later host-side git could descend through: a real
        // repository directory, or a pointer (a gitfile or a symlink). Must
        // mirror the policy's nestedGitFindings descentPoints exactly so the
        // plan-provided baseline and this scan compare like for like.
        if (child === topLevelGit) continue;
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (isRealGitRepository(child)) found.push(child);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          found.push(child);
        }
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
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

/**
 * Renames a nested `.git` to a sibling name git does not treat as a
 * repository (`.git.agenc-moved-<time>`), walking to its parent from `/`
 * through descriptors without following any link, the same walk the removal
 * uses, and renaming within that pinned parent. Returns the new physical path,
 * or undefined when nothing is there. Throws when it cannot move it, so the
 * caller falls back to removal and the protection still holds.
 */
let moveAsideSequence = 0;
function moveGitAside(target: WatchedTarget): string | undefined {
  let directory = fs.openSync(path.sep, DIRECTORY_FLAGS);
  try {
    for (const name of target.parents) {
      const child = openChildDirectory(directory, name);
      if (child.kind !== "directory") throw new Error("nested repository parent is not a plain directory");
      closeQuietly(directory);
      directory = child.fd;
    }
    // withOwnerAccess may add owner rwx to this folder (the user's own) to
    // look up or rename the entry; put its original mode back afterwards.
    const parent = directory;
    const originalMode = fs.statSync(descriptorPath(parent)).mode & 0o7777;
    try {
      return moveWithinParent(parent, target);
    } finally {
      try {
        const self = descriptorPath(parent);
        if ((fs.statSync(self).mode & 0o7777) !== originalMode) fs.chmodSync(self, originalMode);
      } catch {
        // The folder is gone or unreadable: nothing left to restore.
      }
    }
  } finally {
    closeQuietly(directory);
  }
}

/** Renames `target.leaf` within the pinned parent `directory` to a free `.git.agenc-moved-...` name. */
function moveWithinParent(directory: number, target: WatchedTarget): string | undefined {
  if (!entryExists(directory, target.leaf)) return undefined;
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    moveAsideSequence += 1;
    const name = `${target.leaf}.agenc-moved-${stamp}-${process.pid}-${moveAsideSequence}`;
    if (entryExists(directory, name)) continue;
    withOwnerAccess(directory, () => fs.renameSync(descriptorPath(directory, target.leaf), descriptorPath(directory, name)));
    return path.join(path.sep, ...target.parents, name);
  }
  throw new Error("no free name to move the nested repository aside");
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
const attachedNotices = new WeakMap<object, string>();

export function stopAttachedProtectedCreateMonitor(child: object): boolean {
  const monitor = attachedMonitors.get(child);
  if (monitor === undefined) return false;
  attachedMonitors.delete(child);
  const violation = monitor.stop();
  const notice = monitor.notice?.();
  if (notice !== undefined) attachedNotices.set(child, notice);
  return violation;
}

/** The notice of the attached monitor's final check, once, after it stopped. */
export function takeAttachedProtectedCreateNotice(child: object): string | undefined {
  const notice = attachedNotices.get(child);
  attachedNotices.delete(child);
  return notice;
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
