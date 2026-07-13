import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { globby } from "globby";

import { buildProjectTreeRows } from "./buildTree.js";
import { collectGitStatus, listGitFiles, type GitStatusByPath } from "./gitStatus.js";
import { normalizeWorkspacePathForReferences } from "../pathReferences.js";
import type { ProjectTreeRow, ProjectTreeSnapshot } from "../types.js";

type Listener = () => void;
export type ProjectTreeMutationResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

const EMPTY_SNAPSHOT: ProjectTreeSnapshot = Object.freeze({
  cwd: process.cwd(),
  rows: [],
  loading: true,
  error: null,
  cursorPath: null,
  activePath: null,
  expandedPaths: [],
  fileCount: 0,
});
const DEFAULT_VIEWPORT_ROWS = 20;
const WORKSPACE_TREE_IGNORE = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/coverage/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/build/**",
  "**/dist/**",
  "**/out/**",
  "**/target/**",
] as const;
const WORKSPACE_TREE_IGNORED_DIRECTORY_NAMES = new Set(
  WORKSPACE_TREE_IGNORE.flatMap((pattern) => {
    const match = pattern.match(/^\*\*\/([^/]+)\/\*\*$/u);
    return match ? [match[1]!] : [];
  }),
);

export class ProjectTreeStore {
  #cwd: string;
  #refreshIntervalMs: number;
  #paths: readonly string[] = [];
  #gitStatus: GitStatusByPath = new Map();
  #expandedPaths = new Set<string>();
  #cursorPath: string | null = null;
  #activePath: string | null = null;
  #attachedPaths = new Set<string>();
  #searchHitPaths = new Set<string>();
  #inFlightPaths = new Set<string>();
  #viewportRows = DEFAULT_VIEWPORT_ROWS;
  #loading = true;
  #error: string | null = null;
  #listeners = new Set<Listener>();
  #snapshot: ProjectTreeSnapshot = EMPTY_SNAPSHOT;
  #refreshVersion = 0;
  #refreshTimer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  // Directory paths known at the last successful scan, used to detect directories
  // that newly appeared mid-session (an agent-created subpackage) so they can be
  // auto-revealed. Stays null until the first scan establishes the baseline — the
  // initial repo tree must NOT auto-expand (that would explode a large repo).
  #knownDirectories: ReadonlySet<string> | null = null;

  constructor(cwd = process.cwd(), refreshIntervalMs = 5_000) {
    this.#cwd = cwd;
    this.#refreshIntervalMs = refreshIntervalMs;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.refresh();
    if (this.#refreshIntervalMs > 0) {
      this.#refreshTimer = setInterval(() => {
        void this.refresh();
      }, this.#refreshIntervalMs);
      this.#refreshTimer.unref?.();
    }
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ProjectTreeSnapshot => this.#snapshot;

  dispose(): void {
    this.#started = false;
    if (this.#refreshTimer !== null) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    this.#listeners.clear();
  }

  async refresh(): Promise<void> {
    const version = this.#refreshVersion + 1;
    this.#refreshVersion = version;
    this.#loading = true;
    this.#emit();
    try {
      const [paths, gitStatus] = await Promise.all([
        listWorkspacePaths(this.#cwd),
        collectGitStatus(this.#cwd),
      ]);
      if (version !== this.#refreshVersion) return;
      this.#autoExpandNewDirectories(paths);
      this.#paths = paths;
      this.#gitStatus = gitStatus;
      this.#cursorPath = this.#cursorPath ?? firstFilePath(paths) ?? paths[0] ?? null;
      this.#loading = false;
      this.#error = null;
      this.#emit();
    } catch (error) {
      if (version !== this.#refreshVersion) return;
      this.#loading = false;
      this.#error = error instanceof Error ? error.message : String(error);
      this.#emit();
    }
  }

  setActivePath(pathValue: string | null): void {
    const nextPath = normalizeProjectTreeReference(pathValue);
    this.#activePath = nextPath;
    if (nextPath) {
      this.reveal(nextPath);
    }
    this.#emit();
  }

  setAttachedPaths(paths: Iterable<string>): void {
    const next = normalizedPathSet(paths);
    if (sameSet(this.#attachedPaths, next)) return;
    this.#attachedPaths = next;
    this.#emit();
  }

  setSearchHitPaths(paths: Iterable<string>): void {
    const next = normalizedPathSet(paths);
    if (sameSet(this.#searchHitPaths, next)) return;
    this.#searchHitPaths = next;
    this.#emit();
  }

  setInFlightPaths(paths: Iterable<string>): void {
    const next = normalizedPathSet(paths);
    if (sameSet(this.#inFlightPaths, next)) return;
    this.#inFlightPaths = next;
    this.#emit();
  }

  setViewportRows(rows: number): void {
    const nextRows = Math.max(1, Math.floor(rows));
    if (nextRows === this.#viewportRows) return;
    this.#viewportRows = nextRows;
  }

  move(delta: number): void {
    const rows = selectableRows(this.#snapshot.rows);
    if (rows.length === 0) return;
    const current = rows.findIndex((row) => row.path === this.#cursorPath);
    const next = Math.max(0, Math.min(rows.length - 1, (current < 0 ? 0 : current) + delta));
    this.#cursorPath = rows[next]?.path ?? this.#cursorPath;
    this.#emit();
  }

  movePage(delta: number): void {
    this.move(delta * Math.max(1, this.#viewportRows - 1));
  }

  moveToStart(): void {
    const first = selectableRows(this.#snapshot.rows)[0];
    if (!first) return;
    this.#cursorPath = first.path;
    this.#emit();
  }

  moveToEnd(): void {
    const rows = selectableRows(this.#snapshot.rows);
    const last = rows[rows.length - 1];
    if (!last) return;
    this.#cursorPath = last.path;
    this.#emit();
  }

  toggle(pathValue = this.#cursorPath): void {
    const normalizedPath = normalizeProjectTreeReference(pathValue);
    if (!normalizedPath) return;
    const row = this.#rowForPath(normalizedPath);
    if (!row || row.kind !== "directory") return;
    if (this.#expandedPaths.has(normalizedPath)) {
      this.#expandedPaths.delete(normalizedPath);
      if (this.#cursorPath && isDescendantPath(this.#cursorPath, normalizedPath)) {
        this.#cursorPath = normalizedPath;
      }
    } else {
      this.#expandedPaths.add(normalizedPath);
    }
    this.#emit();
  }

  expand(pathValue = this.#cursorPath): void {
    const normalizedPath = normalizeProjectTreeReference(pathValue);
    if (!normalizedPath) return;
    const row = this.#rowForPath(normalizedPath);
    if (!row || row.kind !== "directory") return;
    this.#expandedPaths.add(normalizedPath);
    this.#emit();
  }

  collapse(pathValue = this.#cursorPath): void {
    const normalizedPath = normalizeProjectTreeReference(pathValue);
    if (!normalizedPath) return;
    const row = this.#rowForPath(normalizedPath);
    if (row?.kind === "directory" && this.#expandedPaths.has(normalizedPath)) {
      this.#expandedPaths.delete(normalizedPath);
      if (this.#cursorPath && isDescendantPath(this.#cursorPath, normalizedPath)) {
        this.#cursorPath = normalizedPath;
      }
    } else {
      const parent = parentPath(normalizedPath);
      if (parent !== null) this.#cursorPath = parent;
    }
    this.#emit();
  }

  reveal(pathValue: string | null = this.#activePath): void {
    const normalizedPath = normalizeProjectTreeReference(pathValue);
    if (!normalizedPath) return;
    let parent = parentPath(normalizedPath);
    while (parent !== null) {
      this.#expandedPaths.add(parent);
      parent = parentPath(parent);
    }
    this.#cursorPath = normalizedPath;
    this.#emit();
  }

  getCursorPath(): string | null {
    return this.#cursorPath;
  }

  getCursorRow(): ProjectTreeRow | null {
    return this.#snapshot.rows.find((row) => row.path === this.#cursorPath) ?? null;
  }

  async createFile(relativePath: string): Promise<ProjectTreeMutationResult> {
    const target = resolveWorkspaceRelativePath(this.#cwd, relativePath, { requireFilePath: true });
    if (!target.ok) return target;

    try {
      await mkdir(path.dirname(target.absolutePath), { recursive: true });
      await writeFile(target.absolutePath, "", { flag: "wx" });
      await this.refresh();
      this.reveal(target.relativePath);
      return { ok: true, path: target.relativePath };
    } catch (error) {
      return { ok: false, error: fileActionError("create", target.relativePath, error) };
    }
  }

  async renamePath(fromPath: string, toPath: string): Promise<ProjectTreeMutationResult> {
    const source = resolveWorkspaceRelativePath(this.#cwd, fromPath);
    if (!source.ok) return source;
    const target = resolveWorkspaceRelativePath(this.#cwd, toPath);
    if (!target.ok) return target;

    try {
      if (isDescendantPath(target.relativePath, source.relativePath)) {
        return {
          ok: false,
          error: `Cannot rename ${source.relativePath} to ${target.relativePath}: target is inside the source path.`,
        };
      }
      if (await pathExists(target.absolutePath)) {
        return { ok: false, error: `Cannot rename to ${target.relativePath}: path already exists.` };
      }
      await mkdir(path.dirname(target.absolutePath), { recursive: true });
      await rename(source.absolutePath, target.absolutePath);
      this.#renameExpandedPaths(source.relativePath, target.relativePath);
      await this.refresh();
      this.reveal(target.relativePath);
      return { ok: true, path: target.relativePath };
    } catch (error) {
      return { ok: false, error: fileActionError("rename", source.relativePath, error) };
    }
  }

  async deletePath(relativePath: string): Promise<ProjectTreeMutationResult> {
    const target = resolveWorkspaceRelativePath(this.#cwd, relativePath);
    if (!target.ok) return target;

    try {
      await rm(target.absolutePath, { recursive: true });
      this.#deleteExpandedPaths(target.relativePath);
      await this.refresh();
      this.reveal(parentPath(target.relativePath));
      return { ok: true, path: target.relativePath };
    } catch (error) {
      return { ok: false, error: fileActionError("delete", target.relativePath, error) };
    }
  }

  /**
   * Auto-reveal directories that appeared since the last scan. When AgenC writes
   * files into a NEW subdirectory mid-session (e.g. a `converters/` subpackage),
   * that directory would otherwise render collapsed and the freshly-written files
   * would stay hidden in the tree. Expanding only the directories that newly
   * appeared keeps this scoped to agent-created/just-modified dirs — the initial
   * repo tree is never force-expanded (the first scan only records the baseline),
   * so large repos do not blow up. It is a one-time reveal on appearance, not a
   * persistent override: if the user later collapses the directory, the next scan
   * no longer sees it as "new", so the collapse sticks.
   */
  #autoExpandNewDirectories(nextPaths: readonly string[]): void {
    const nextDirectories = collectDirectoryPaths(nextPaths);
    // First successful scan only establishes the baseline; do not auto-expand the
    // existing repo tree.
    if (this.#knownDirectories === null) {
      this.#knownDirectories = nextDirectories;
      return;
    }
    const known = this.#knownDirectories;
    for (const directory of nextDirectories) {
      if (!known.has(directory)) this.#expandedPaths.add(directory);
    }
    this.#knownDirectories = nextDirectories;
  }

  #rowForPath(pathValue: string): ProjectTreeRow | null {
    return this.#snapshot.rows.find((row) => row.path === pathValue) ?? null;
  }

  #renameExpandedPaths(fromPath: string, toPath: string): void {
    const next = new Set<string>();
    for (const expandedPath of this.#expandedPaths) {
      if (expandedPath === fromPath) {
        next.add(toPath);
      } else if (isDescendantPath(expandedPath, fromPath)) {
        next.add(`${toPath}${expandedPath.slice(fromPath.length)}`);
      } else {
        next.add(expandedPath);
      }
    }
    this.#expandedPaths = next;
  }

  #deleteExpandedPaths(pathValue: string): void {
    for (const expandedPath of [...this.#expandedPaths]) {
      if (expandedPath === pathValue || isDescendantPath(expandedPath, pathValue)) {
        this.#expandedPaths.delete(expandedPath);
      }
    }
  }

  #emit(): void {
    const rows = buildProjectTreeRows({
      cwd: this.#cwd,
      paths: this.#paths,
      expandedPaths: this.#expandedPaths,
      cursorPath: this.#cursorPath,
      activePath: this.#activePath,
      attachedPaths: this.#attachedPaths,
      searchHitPaths: this.#searchHitPaths,
      inFlightPaths: this.#inFlightPaths,
      gitStatus: this.#gitStatus,
      focused: true,
    });
    const normalizedCursorPath = visibleCursorPath(this.#cursorPath, rows);
    const visibleRows = normalizedCursorPath === this.#cursorPath
      ? rows
      : buildProjectTreeRows({
        cwd: this.#cwd,
        paths: this.#paths,
        expandedPaths: this.#expandedPaths,
        cursorPath: normalizedCursorPath,
        activePath: this.#activePath,
        attachedPaths: this.#attachedPaths,
        searchHitPaths: this.#searchHitPaths,
        inFlightPaths: this.#inFlightPaths,
        gitStatus: this.#gitStatus,
        focused: true,
      });
    this.#cursorPath = normalizedCursorPath;
    this.#snapshot = {
      cwd: this.#cwd,
      rows: visibleRows,
      loading: this.#loading,
      error: this.#error,
      cursorPath: this.#cursorPath,
      activePath: this.#activePath,
      expandedPaths: [...this.#expandedPaths],
      // Count the real project files (collapse-independent) rather than the
      // currently-visible rows, so the WORKSPACE header never undercounts a
      // project whose files sit inside a collapsed directory.
      fileCount: countFilePaths(this.#paths),
    };
    for (const listener of this.#listeners) listener();
  }
}

let singleton: ProjectTreeStore | null = null;

export function getProjectTreeStore(): ProjectTreeStore {
  singleton ??= new ProjectTreeStore();
  return singleton;
}

function selectableRows(rows: readonly ProjectTreeRow[]): readonly ProjectTreeRow[] {
  return rows.filter((row) => row.kind === "file" || row.kind === "directory");
}

function visibleCursorPath(cursorPath: string | null, rows: readonly ProjectTreeRow[]): string | null {
  const selectable = selectableRows(rows);
  if (selectable.length === 0) return null;
  if (cursorPath && selectable.some((row) => row.path === cursorPath)) return cursorPath;

  let parent = cursorPath ? parentPath(cursorPath) : null;
  while (parent !== null) {
    const visibleParent = selectable.find((row) => row.path === parent);
    if (visibleParent) return visibleParent.path;
    parent = parentPath(parent);
  }

  return selectable[0]?.path ?? cursorPath;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function normalizeProjectTreeReference(pathValue: string | null): string | null {
  return pathValue === null ? null : normalizeWorkspacePathForReferences(pathValue);
}

function normalizedPathSet(paths: Iterable<string>): Set<string> {
  return new Set([...paths].map((pathValue) => normalizeWorkspacePathForReferences(pathValue)));
}

function firstFilePath(paths: readonly string[]): string | null {
  return paths.find((item) => item.length > 0 && !item.endsWith("/")) ?? null;
}

/**
 * Count the file entries in a workspace path list. Directory entries carry a
 * trailing slash (see `normalizeScannedPath`); git-tracked paths are always
 * files. Counting files (not directories) keeps the WORKSPACE header reading as
 * "how many files exist", which is what the at-a-glance anchor is meant to show.
 */
function countFilePaths(paths: readonly string[]): number {
  let count = 0;
  for (const item of paths) {
    if (item.length > 0 && !item.endsWith("/")) count += 1;
  }
  return count;
}

/**
 * Derive every directory path implied by a workspace path list. Git-tracked
 * paths are files, so a directory appears only as an ANCESTOR of a file; the
 * recursive scanner may also list a directory explicitly with a trailing slash.
 * Both forms collapse to the same slash-free relative directory path here, so a
 * directory's "is it new this scan" status is stable across the git and scanner
 * fallbacks (matching how `addPathItems` materializes directory rows).
 */
function collectDirectoryPaths(paths: readonly string[]): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const rawPath of paths) {
    if (rawPath.length === 0 || rawPath.startsWith("../")) continue;
    const isDirectoryEntry = rawPath.endsWith("/");
    const trimmed = rawPath.replace(/\/+$/u, "");
    if (trimmed.length === 0) continue;
    const segments = trimmed.split("/").filter(Boolean);
    // For a file, every parent segment is a directory; for an explicit directory
    // entry, the entry itself is also a directory.
    const lastDirectoryIndex = isDirectoryEntry ? segments.length : segments.length - 1;
    for (let index = 1; index <= lastDirectoryIndex; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
}

function parentPath(value: string): string | null {
  const parent = path.posix.dirname(value.split(path.sep).join("/"));
  return parent === "." || parent === value ? null : parent;
}

function isDescendantPath(value: string, possibleAncestor: string): boolean {
  return value.length > possibleAncestor.length && value.startsWith(`${possibleAncestor}/`);
}

async function readTopLevelPaths(cwd: string): Promise<string[]> {
  const entries = await readdir(cwd, { withFileTypes: true });
  return entries
    .filter((entry) => !(entry.isDirectory() && WORKSPACE_TREE_IGNORED_DIRECTORY_NAMES.has(entry.name)))
    .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function listWorkspacePaths(cwd: string): Promise<string[]> {
  const gitPaths = await listGitFiles(cwd);
  if (gitPaths && gitPaths.length > 0) return gitPaths;

  const scannedPaths = await scanWorkspacePaths(cwd);
  if (scannedPaths.length > 0) return scannedPaths;

  return readTopLevelPaths(cwd);
}

async function scanWorkspacePaths(cwd: string): Promise<string[]> {
  const entries = await globby(["**/*"], {
    cwd,
    dot: true,
    gitignore: true,
    ignore: [...WORKSPACE_TREE_IGNORE],
    objectMode: true,
    onlyFiles: false,
    unique: true,
  });

  return entries
    .map((entry) => normalizeScannedPath(entry.path, entry.dirent.isDirectory()))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function normalizeScannedPath(pathValue: string, isDirectory: boolean): string {
  const normalized = pathValue.split(path.sep).join("/");
  return isDirectory ? `${normalized}/` : normalized;
}

function resolveWorkspaceRelativePath(
  cwd: string,
  inputPath: string,
  options: { readonly requireFilePath?: boolean } = {},
): { readonly ok: true; readonly relativePath: string; readonly absolutePath: string } | { readonly ok: false; readonly error: string } {
  const input = inputPath.replace(/\\/gu, "/");
  if (input.trim().length === 0) return { ok: false, error: "Enter a workspace-relative path." };
  if (isWindowsDriveQualifiedPath(input) || path.posix.isAbsolute(input) || path.isAbsolute(input)) {
    return { ok: false, error: "Use a workspace-relative path, not an absolute path." };
  }

  const normalizedPath = path.posix.normalize(input).replace(/^\.\//u, "");
  if (options.requireFilePath && normalizedPath.endsWith("/")) {
    return { ok: false, error: "Enter a file path, not a directory path." };
  }

  const relativePath = stripTrailingSlashes(normalizedPath);
  if (!relativePath || relativePath === "." || relativePath.startsWith("../")) {
    return { ok: false, error: "Path must stay inside the workspace." };
  }

  const root = path.resolve(cwd);
  const absolutePath = path.resolve(root, relativePath);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolutePath !== root && !absolutePath.startsWith(rootWithSeparator)) {
    return { ok: false, error: "Path must stay inside the workspace." };
  }
  if (absolutePath === root) {
    return { ok: false, error: "Choose a path below the workspace root." };
  }

  return { ok: true, relativePath, absolutePath };
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isWindowsDriveQualifiedPath(value: string): boolean {
  return /^[A-Za-z]:/u.test(value);
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function fileActionError(action: string, relativePath: string, error: unknown): string {
  if (isNodeError(error) && error.code === "EEXIST") {
    return `Cannot ${action} ${relativePath}: path already exists.`;
  }
  if (isNodeError(error) && error.code === "ENOENT") {
    return `Cannot ${action} ${relativePath}: path does not exist.`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Cannot ${action} ${relativePath}: ${detail}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
