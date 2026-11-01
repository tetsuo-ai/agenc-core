/**
 * Workspace file names with the first message of an interactive DeepSeek Light session.
 *
 * In the race receipts (round 4 job dsw: 110 DeepSeek Flash Light cells of the 11 race tasks), 75 cells
 * spent their first model call on a listing (`ls -la`, `find . -maxdepth 3 -type f | head`) before reading
 * anything: about 1.25 s of provider time plus a command each, and the listing's output then rode along in
 * every later request. With the names already in front of it, DeepSeek read the files it needed in its first
 * call (replay pilot, jobs/dsw/replay). The listing is taken once, when the conversation starts, from the
 * folder the user opened, only when that folder belongs to a git work tree and is neither the home folder nor
 * the filesystem root, by identity. Names only, never contents; folders that hold dependencies, caches or version control
 * are shown but not expanded. The names are workspace data, framed like Light's workspace tool results.
 *
 * @module
 */

import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { AttachmentProducer } from "./orchestrator.js";

/** Folder levels below the workspace that are expanded (the depth DeepSeek's own listings used). */
export const WORKSPACE_FILES_MAX_DEPTH = 3;
/** Most names one listing carries. */
export const WORKSPACE_FILES_MAX_ENTRIES = 50;
/** Most folders one listing reads, so a large tree costs a bounded walk. */
export const WORKSPACE_FILES_MAX_DIRS = 64;

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

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** The folder belongs to a git work tree: it or one of its parents holds `.git`. */
async function insideGitWorkTree(cwd: string): Promise<boolean> {
  let dir = cwd;
  for (;;) {
    if (await exists(path.join(dir, ".git"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** The canonical directory behind `target` (every link resolved), or undefined when that fails. */
async function canonicalDirectory(target: string): Promise<DirectoryIdentity | undefined> {
  try {
    const real = await realpath(target);
    const info = await lstat(real);
    return info.isDirectory() ? { path: real, dev: info.dev, ino: info.ino } : undefined;
  } catch {
    return undefined;
  }
}

function sameDirectory(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * The canonical directory a listing may describe, or undefined: a git work tree that is not the home folder,
 * not the filesystem root, not a folder that holds the home folder, and no alias of any of them (directories
 * compare by device and inode after every link is resolved, so a second spelling or a bind mount of the home
 * folder is the home folder). Anything that cannot be resolved, the home folder included, describes nothing.
 */
export async function listableWorkspace(
  cwd: string,
  home: string = homedir(),
): Promise<DirectoryIdentity | undefined> {
  const root = await canonicalDirectory(cwd);
  if (root === undefined) return undefined;
  const filesystemRoot = await canonicalDirectory(path.parse(root.path).root);
  if (filesystemRoot === undefined || sameDirectory(root, filesystemRoot)) return undefined;
  const homeDir = home.length > 0 ? await canonicalDirectory(home) : undefined;
  if (homeDir === undefined || sameDirectory(root, homeDir)) return undefined;
  const prefix = root.path.endsWith(path.sep) ? root.path : `${root.path}${path.sep}`;
  if (homeDir.path.startsWith(prefix)) return undefined;
  return (await insideGitWorkTree(root.path)) ? root : undefined;
}

/**
 * Breadth-first names under `cwd`, nearest levels first, then sorted. Symbolic links are listed, never
 * followed. Unreadable folders are skipped.
 */
export async function listWorkspaceFiles(
  cwd: string,
  signal?: AbortSignal,
): Promise<WorkspaceFileListing> {
  const entries: string[] = [];
  let truncated = false;
  let dirsRead = 0;
  const queue: Array<{ readonly rel: string; readonly depth: number }> = [{ rel: "", depth: 1 }];
  outer: while (queue.length > 0) {
    if (signal?.aborted === true) break;
    const { rel, depth } = queue.shift()!;
    if (dirsRead >= WORKSPACE_FILES_MAX_DIRS) {
      truncated = true;
      break;
    }
    dirsRead += 1;
    let children;
    try {
      children = await readdir(path.join(cwd, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (entries.length >= WORKSPACE_FILES_MAX_ENTRIES) {
        truncated = true;
        break outer;
      }
      const name = rel.length > 0 ? `${rel}/${child.name}` : child.name;
      if (child.isDirectory()) {
        if (NOT_EXPANDED.has(child.name) || depth >= WORKSPACE_FILES_MAX_DEPTH) {
          entries.push(`${name}/`);
        } else {
          queue.push({ rel: name, depth: depth + 1 });
        }
        continue;
      }
      entries.push(name);
    }
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
  // Only the validated canonical directory is enumerated, never the spelling the session started with.
  const workspace = await listableWorkspace(opts.cwd);
  if (workspace === undefined) return [];
  const listing = await listWorkspaceFiles(workspace.path, opts.signal);
  if (listing.entries.length === 0) return [];
  return [{ kind: "workspace_files", entries: listing.entries, truncated: listing.truncated }];
};
