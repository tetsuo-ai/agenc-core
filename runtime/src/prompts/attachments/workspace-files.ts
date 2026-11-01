/**
 * Workspace file names with the first message of an interactive DeepSeek Light session.
 *
 * In the race receipts (round 4 job dsw: 110 DeepSeek Flash Light cells of the 11 race tasks), 75 cells
 * spent their first model call on a listing (`ls -la`, `find . -maxdepth 3 -type f | head`) before reading
 * anything: about 1.25 s of provider time plus a command each, and the listing's output then rode along in
 * every later request. With the names already in front of it, DeepSeek read the files it needed in its first
 * call (replay pilot, jobs/dsw/replay). The listing is taken once, when the conversation starts, from the
 * canonical folder the user opened, only when it is a git work tree by its metadata and is neither the home
 * folder nor the filesystem root (compared by identity). Names only, never contents; folders that hold
 * dependencies, caches or version control are shown but not expanded. The walk re-checks every folder around
 * its read, is bounded in entries, folders and time, and is left out after a short deadline. The names are
 * untrusted workspace data, sanitized and framed like Light's workspace tool results (messages.ts).
 *
 * @module
 */

import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { AttachmentProducer } from "./orchestrator.js";

/** Folder levels below the workspace that are expanded (the depth DeepSeek's own listings used). */
export const WORKSPACE_FILES_MAX_DEPTH = 3;
/** Most names one listing carries. */
export const WORKSPACE_FILES_MAX_ENTRIES = 50;
/** Most folders one listing reads, so a large tree costs a bounded walk. */
export const WORKSPACE_FILES_MAX_DIRS = 64;
/** Most folders waiting to be read; a folder found beyond this is named, not expanded. */
export const WORKSPACE_FILES_MAX_QUEUED = 64;
/** Most directory entries one listing looks at, read one at a time, so a huge folder costs a bounded read. */
export const WORKSPACE_FILES_MAX_INSPECTED = 1_000;
/**
 * The listing is optional: if checking the folder and walking it take longer than this, the first request
 * goes without it, and a slow or stalled read cannot hold the request back any longer.
 */
export const WORKSPACE_FILES_DEADLINE_MS = 200;

/** Shown with a trailing slash and never expanded. */
const NOT_EXPANDED: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".next",
  ".turbo",
]);

/** A directory by identity: its canonical path and its device and inode numbers. */
export interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

export interface WorkspaceFileListing {
  readonly entries: readonly string[];
  readonly truncated: boolean;
}

/**
 * Read through a call, so each check sees the signal's current state: an abort can land during any await, and
 * a property read would be narrowed away after the first check.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Most bytes read from a `.git` file, which holds one `gitdir:` line. */
const GIT_FILE_MAX_BYTES = 4_096;

/**
 * A small regular file, read through a descriptor opened without following a link and without blocking (a FIFO
 * swapped in for the file would otherwise hold a filesystem worker until a writer appears): the descriptor must
 * be a regular file of at most `max` bytes, and at most that much is read. Undefined for anything else, or where
 * the platform lacks those open flags.
 */
async function readSmallRegularFile(target: string, max: number, signal?: AbortSignal): Promise<string | undefined> {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants;
  if (isAborted(signal) || O_NOFOLLOW === undefined || O_NONBLOCK === undefined) return undefined;
  let handle;
  try {
    handle = await open(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max || isAborted(signal)) return undefined;
    const buffer = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buffer, 0, max, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Most bytes read from a repository config. */
const GIT_CONFIG_MAX_BYTES = 65_536;
/** HEAD: a symbolic ref under refs/, or a SHA-1 or SHA-256 object id. */
const GIT_HEAD = /^(?:ref: refs\/\S+|[0-9a-f]{40}|[0-9a-f]{64})\r?\n?$/u;

/** lstat without following a link: "missing", the stats, or undefined for any other failure. */
async function lstatOrMissing(target: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof lstat>> | "missing" | undefined> {
  if (isAborted(signal)) return undefined;
  try {
    return await lstat(target);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : undefined;
  }
}

/** Whether a git config text sets core.bare to true (the last setting wins; a bare key means true). */
export function gitConfigSetsBare(text: string): boolean {
  let section = "";
  let bare = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\]/u.exec(line);
    if (header !== null) {
      section = header[1]!.toLowerCase();
      continue;
    }
    if (section !== "core") continue;
    const entry = /^bare\s*(?:=\s*([^#;]*))?(?:[#;].*)?$/iu.exec(line);
    if (entry !== null) bare = ["true", "yes", "on", "1"].includes((entry[1] ?? "true").trim().toLowerCase());
  }
  return bare;
}

/** false when a config is absent or does not make the repository bare; true when it does; undefined when unreadable. */
async function configMakesBare(config: string, signal?: AbortSignal): Promise<boolean | undefined> {
  const info = await lstatOrMissing(config, signal);
  if (info === "missing") return false;
  if (info === undefined) return undefined;
  const text = await readSmallRegularFile(config, GIT_CONFIG_MAX_BYTES, signal);
  return text === undefined ? undefined : gitConfigSetsBare(text);
}

async function isRealDirectory(target: string, signal?: AbortSignal): Promise<boolean> {
  const info = await lstatOrMissing(target, signal);
  return info !== undefined && info !== "missing" && info.isDirectory();
}

/**
 * Whether `gitDir` is the metadata of a repository with a work tree, checked without running git (a repository's
 * config can make git run programs): HEAD is a symbolic ref under refs/ or an object id; objects/ and refs/ are
 * directories there, or in the common directory that a linked worktree's commondir names; and the config that
 * applies (the repository's, or a linked worktree's config.worktree) does not set core.bare. Anything malformed or
 * unreadable is not a work tree.
 */
async function validGitDir(gitDir: string, signal?: AbortSignal): Promise<boolean> {
  const head = await readSmallRegularFile(path.join(gitDir, "HEAD"), GIT_FILE_MAX_BYTES, signal);
  if (head === undefined || !GIT_HEAD.test(head)) return false;
  let common = gitDir;
  const commondir = path.join(gitDir, "commondir");
  const commondirInfo = await lstatOrMissing(commondir, signal);
  if (commondirInfo === undefined) return false;
  if (commondirInfo !== "missing") {
    const target = (await readSmallRegularFile(commondir, GIT_FILE_MAX_BYTES, signal))?.trim();
    if (target === undefined || target.length === 0 || /[\r\n]/u.test(target)) return false;
    common = path.resolve(gitDir, target);
  }
  if (!(await isRealDirectory(path.join(common, "objects"), signal)) ||
      !(await isRealDirectory(path.join(common, "refs"), signal))) {
    return false;
  }
  const config = common === gitDir ? path.join(gitDir, "config") : path.join(gitDir, "config.worktree");
  return (await configMakesBare(config, signal)) === false;
}

/** The `gitdir:` target of a `.git` file, resolved against the folder that holds it. */
async function gitFileTarget(gitFile: string, signal?: AbortSignal): Promise<string | undefined> {
  const text = await readSmallRegularFile(gitFile, GIT_FILE_MAX_BYTES, signal);
  const match = text === undefined ? null : /^gitdir:[ \t]*(\S.*?)[ \t]*$/mu.exec(text);
  return match?.[1] === undefined ? undefined : path.resolve(path.dirname(gitFile), match[1]);
}

/**
 * The folder belongs to a git work tree, by its metadata and without running git: the nearest `.git` above
 * it (the folder itself included) is valid git metadata (validGitDir), either the directory itself or the one a
 * `.git` file's `gitdir:` line names, as linked worktrees and submodules have. An empty or broken marker, a link,
 * or a folder inside the metadata itself (any `.git` part of the path) is not a work tree.
 */
async function insideGitWorkTree(cwd: string, signal?: AbortSignal): Promise<boolean> {
  if (cwd.split(path.sep).includes(".git")) return false;
  let dir = cwd;
  for (;;) {
    if (isAborted(signal)) return false;
    const marker = path.join(dir, ".git");
    try {
      const info = await lstat(marker);
      if (info.isDirectory()) return await validGitDir(marker, signal);
      if (!info.isFile()) return false;
      const target = await gitFileTarget(marker, signal);
      return target !== undefined && await validGitDir(target, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** The canonical directory behind `target` (every link resolved), or undefined when that fails. */
async function canonicalDirectory(target: string, signal?: AbortSignal): Promise<DirectoryIdentity | undefined> {
  if (isAborted(signal)) return undefined;
  try {
    const real = await realpath(target);
    if (isAborted(signal)) return undefined;
    const info = await lstat(real);
    return info.isDirectory() ? { path: real, dev: info.dev, ino: info.ino } : undefined;
  } catch {
    return undefined;
  }
}

function sameDirectory(
  a: Pick<DirectoryIdentity, "dev" | "ino">,
  b: Pick<DirectoryIdentity, "dev" | "ino">,
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * The canonical directory a listing may describe, or undefined: a git work tree that is neither the home
 * folder nor any folder above it, the filesystem root included. Directories compare by device and inode, never
 * by spelling: a canonical path need not be unique (a bind mount of /home is another canonical path of the
 * folder that holds the home folder). Anything that cannot be resolved, the home folder or one of its
 * ancestors included, describes nothing.
 */
export async function listableWorkspace(
  cwd: string,
  home: string = homedir(),
  signal?: AbortSignal,
): Promise<DirectoryIdentity | undefined> {
  const root = await canonicalDirectory(cwd, signal);
  if (root === undefined) return undefined;
  const filesystemRoot = await canonicalDirectory(path.parse(root.path).root, signal);
  if (filesystemRoot === undefined || sameDirectory(root, filesystemRoot)) return undefined;
  const homeDir = home.length > 0 ? await canonicalDirectory(home, signal) : undefined;
  if (homeDir === undefined) return undefined;
  for (let dir = homeDir.path; ; dir = path.dirname(dir)) {
    if (isAborted(signal)) return undefined;
    try {
      if (sameDirectory(root, await lstat(dir))) return undefined;
    } catch {
      return undefined;
    }
    if (path.dirname(dir) === dir) break;
  }
  return (await insideGitWorkTree(root.path, signal)) ? root : undefined;
}

interface WalkBudget {
  inspected: number;
  readonly signal?: AbortSignal;
}

/** A folder entry; a folder that may be expanded carries the identity a later read must find. */
interface WalkEntry {
  readonly name: string;
  readonly folder: boolean;
  readonly identity?: Pick<DirectoryIdentity, "dev" | "ino">;
}

/** Where the entries of an open directory descriptor can be read by path (Linux, macOS); elsewhere none. */
function descriptorDirectory(fd: number): string | undefined {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  return undefined;
}

/**
 * One folder of the walk, read through a pinned descriptor: the folder is opened without following a link
 * (O_DIRECTORY | O_NOFOLLOW), the open descriptor must be a directory with the expected device and inode (the
 * validated root's, or what the parent's read found for that entry), and the entries are read through the
 * descriptor itself, so a folder swapped and restored around the open cannot put another directory's names in
 * the listing. Folder entries that may be expanded get their identity from inside the pinned folder. Undefined
 * (the folder is dropped) on any mismatch or failure, and on a platform without these flags or a descriptor
 * path, where no listing is sent at all. Every handle is closed.
 */
async function readPinnedDirectory(
  target: string,
  expected: Pick<DirectoryIdentity, "dev" | "ino">,
  budget: WalkBudget,
  expandable: boolean,
): Promise<{ readonly children: WalkEntry[]; readonly complete: boolean } | undefined> {
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = constants;
  if (O_DIRECTORY === undefined || O_NOFOLLOW === undefined || isAborted(budget.signal)) return undefined;
  let handle;
  try {
    handle = await open(target, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    const pinned = descriptorDirectory(handle.fd);
    if (!info.isDirectory() || !sameDirectory(expected, info) || pinned === undefined) return undefined;
    // One entry at a time, so the inspection cap and an abort stop the read itself.
    const children: WalkEntry[] = [];
    let complete = true;
    const dir = await opendir(pinned);
    try {
      for (;;) {
        if (isAborted(budget.signal) || budget.inspected >= WORKSPACE_FILES_MAX_INSPECTED) {
          complete = false;
          break;
        }
        const child = await dir.read();
        if (child === null) break;
        budget.inspected += 1;
        if (!child.isDirectory()) {
          children.push({ name: child.name, folder: false });
        } else if (!expandable || NOT_EXPANDED.has(child.name)) {
          children.push({ name: child.name, folder: true });
        } else {
          const entry = await lstat(path.join(pinned, child.name)).catch(() => undefined);
          children.push(entry === undefined
            ? { name: child.name, folder: true }
            : entry.isDirectory()
              ? { name: child.name, folder: true, identity: { dev: entry.dev, ino: entry.ino } }
              : { name: child.name, folder: false });
        }
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
    return { children, complete };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Breadth-first names under the workspace, nearest levels first, then sorted. Symbolic links are listed,
 * never followed. Unreadable folders, and folders that change under the walk, are skipped (readPinnedDirectory). A path is first
 * resolved to its canonical directory; one that cannot be resolved lists nothing.
 */
export async function listWorkspaceFiles(
  workspace: DirectoryIdentity | string,
  signal?: AbortSignal,
): Promise<WorkspaceFileListing> {
  const root = typeof workspace === "string" ? await canonicalDirectory(workspace) : workspace;
  if (root === undefined) return { entries: [], truncated: false };
  const entries: string[] = [];
  let truncated = false;
  let dirsRead = 0;
  const budget: WalkBudget = { inspected: 0, ...(signal !== undefined ? { signal } : {}) };
  const queue: Array<{ readonly rel: string; readonly depth: number; readonly identity: Pick<DirectoryIdentity, "dev" | "ino"> }> =
    [{ rel: "", depth: 1, identity: root }];
  outer: while (queue.length > 0) {
    if (isAborted(signal)) {
      truncated = true;
      break;
    }
    if (dirsRead >= WORKSPACE_FILES_MAX_DIRS) {
      truncated = true;
      break;
    }
    const { rel, depth, identity } = queue.shift()!;
    dirsRead += 1;
    const read = await readPinnedDirectory(
      rel.length === 0 ? root.path : path.join(root.path, rel),
      identity,
      budget,
      depth < WORKSPACE_FILES_MAX_DEPTH,
    );
    if (read === undefined) continue;
    const children = read.children;
    if (!read.complete) truncated = true;
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (entries.length >= WORKSPACE_FILES_MAX_ENTRIES) {
        truncated = true;
        break outer;
      }
      const name = rel.length > 0 ? `${rel}/${child.name}` : child.name;
      if (child.folder) {
        if (child.identity === undefined || queue.length >= WORKSPACE_FILES_MAX_QUEUED) {
          entries.push(`${name}/`);
        } else {
          queue.push({ rel: name, depth: depth + 1, identity: child.identity });
        }
        continue;
      }
      entries.push(name);
    }
    // The inspection cap or an abort stopped this read: what is still queued is named, not expanded.
    if (!read.complete) break;
  }
  // Folders still queued when the walk stopped are named, not expanded.
  for (const { rel } of queue) {
    if (entries.length >= WORKSPACE_FILES_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push(`${rel}/`);
  }
  entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { entries, truncated };
}

export const workspaceFilesProducer: AttachmentProducer = async (opts, trackingState) => {
  if (opts.lightWorkspaceFiles !== true || trackingState.workspaceFilesSent === true) return [];
  // Only the human's first message of a conversation; a synthetic follow-up, a delegated child turn or
  // a resumed conversation gets nothing.
  const provenance = opts.turnProvenance;
  const root = provenance?.rootHumanTurn;
  if (provenance === undefined || root === null || root === undefined ||
      root.turnId !== provenance.turnId || opts.subagentDepth > 0) {
    return [];
  }
  if (opts.messages.some((message) => message.role === "assistant" || message.role === "tool")) {
    return [];
  }
  trackingState.workspaceFilesSent = true;
  const listing = await withinDeadline(opts.cwd, opts.signal);
  if (listing === undefined || listing.entries.length === 0) return [];
  return [{ kind: "workspace_files", entries: listing.entries, truncated: listing.truncated }];
};

/**
 * The checks and the walk under WORKSPACE_FILES_DEADLINE_MS. When the deadline passes (or the turn is
 * aborted) the result is undefined at once and the walk is told to stop; a read already in progress
 * finishes in the background and its result is dropped.
 */
async function withinDeadline(cwd: string, turnSignal: AbortSignal): Promise<WorkspaceFileListing | undefined> {
  // An aborted turn starts no filesystem work at all.
  if (isAborted(turnSignal)) return undefined;
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const expired = new Promise<undefined>((resolve) => {
    const end = () => {
      stop.abort();
      resolve(undefined);
    };
    timer = setTimeout(end, WORKSPACE_FILES_DEADLINE_MS);
    timer.unref?.();
    onAbort = end;
    if (isAborted(turnSignal)) end();
    else turnSignal.addEventListener("abort", end, { once: true });
  });
  const walk = (async () => {
    // Only the validated canonical directory is enumerated, never the spelling the session started with.
    const workspace = await listableWorkspace(cwd, homedir(), stop.signal);
    if (workspace === undefined || isAborted(stop.signal)) return undefined;
    const listing = await listWorkspaceFiles(workspace, stop.signal);
    return isAborted(stop.signal) ? undefined : listing;
  })().catch(() => undefined);
  try {
    return await Promise.race([walk, expired]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) turnSignal.removeEventListener("abort", onAbort);
    stop.abort();
  }
}
