/**
 * Workspace file names with the first message of an interactive DeepSeek Light session.
 *
 * In the race receipts (round 4 job dsw: 110 DeepSeek Flash Light cells of the 11 race tasks), 75 cells
 * spent their first model call on a listing (`ls -la`, `find . -maxdepth 3 -type f | head`) before reading
 * anything: about 1.25 s of provider time plus a command each, and the listing's output then rode along in
 * every later request. With the names already in front of it, DeepSeek read the files it needed in its first
 * call (replay pilot, jobs/dsw/replay). The listing is taken once, when the conversation starts, from the
 * folder the user opened, only when that folder belongs to a git work tree and is neither the home folder nor
 * the filesystem root. Names only, never contents; folders that hold dependencies, caches or version control
 * are shown but not expanded. The names are workspace data, framed like Light's workspace tool results.
 *
 * @module
 */

import { readdir, stat } from "node:fs/promises";
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

/**
 * Whether a folder is a project the listing may describe: a git work tree, but not the home folder or
 * the filesystem root (a session opened there would send names the request may not be about).
 */
export async function listableWorkspace(cwd: string, home: string = homedir()): Promise<boolean> {
  const resolved = path.resolve(cwd);
  if (resolved === path.parse(resolved).root) return false;
  if (home.length > 0 && resolved === path.resolve(home)) return false;
  return insideGitWorkTree(resolved);
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
  if (!(await listableWorkspace(opts.cwd))) return [];
  const listing = await listWorkspaceFiles(opts.cwd, opts.signal);
  if (listing.entries.length === 0) return [];
  return [{ kind: "workspace_files", entries: listing.entries, truncated: listing.truncated }];
};
