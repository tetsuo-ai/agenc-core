import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { globby } from "globby";

import { buildProjectTreeRows, visibleTreePaths } from "./buildTree.js";
import { collectGitStatus, listGitFiles, type GitStatusByPath } from "./gitStatus.js";
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
    this.#activePath = pathValue;
    if (pathValue) {
      this.reveal(pathValue);
    }
    this.#emit();
  }

  setAttachedPaths(paths: Iterable<string>): void {
    const next = new Set(paths);
    if (sameSet(this.#attachedPaths, next)) return;
    this.#attachedPaths = next;
    this.#emit();
  }

  setSearchHitPaths(paths: Iterable<string>): void {
    const next = new Set(paths);
    if (sameSet(this.#searchHitPaths, next)) return;
    this.#searchHitPaths = next;
    this.#emit();
  }

  setInFlightPaths(paths: Iterable<string>): void {
    const next = new Set(paths);
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
    if (!pathValue) return;
    const row = this.#rowForPath(pathValue);
    if (!row || row.kind !== "directory") return;
    if (this.#expandedPaths.has(pathValue)) {
      this.#expandedPaths.delete(pathValue);
      if (this.#cursorPath && isDescendantPath(this.#cursorPath, pathValue)) {
        this.#cursorPath = pathValue;
      }
    } else {
      this.#expandedPaths.add(pathValue);
    }
    this.#emit();
  }

  expand(pathValue = this.#cursorPath): void {
    if (!pathValue) return;
    const row = this.#rowForPath(pathValue);
    if (!row || row.kind !== "directory") return;
    this.#expandedPaths.add(pathValue);
    this.#emit();
  }

  collapse(pathValue = this.#cursorPath): void {
    if (!pathValue) return;
    const row = this.#rowForPath(pathValue);
    if (row?.kind === "directory" && this.#expandedPaths.has(pathValue)) {
      this.#expandedPaths.delete(pathValue);
      if (this.#cursorPath && isDescendantPath(this.#cursorPath, pathValue)) {
        this.#cursorPath = pathValue;
      }
    } else {
      const parent = parentPath(pathValue);
      if (parent !== null) this.#cursorPath = parent;
    }
    this.#emit();
  }

  reveal(pathValue: string | null = this.#activePath): void {
    if (!pathValue) return;
    let parent = parentPath(pathValue);
    while (parent !== null) {
      this.#expandedPaths.add(parent);
      parent = parentPath(parent);
    }
    this.#cursorPath = pathValue;
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
      if (await pathExists(target.absolutePath)) {
        return { ok: false, error: `Cannot rename to ${target.relativePath}: path already exists.` };
      }
      await mkdir(path.dirname(target.absolutePath), { recursive: true });
      await rename(source.absolutePath, target.absolutePath);
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
      await this.refresh();
      this.reveal(parentPath(target.relativePath));
      return { ok: true, path: target.relativePath };
    } catch (error) {
      return { ok: false, error: fileActionError("delete", target.relativePath, error) };
    }
  }

  #rowForPath(pathValue: string): ProjectTreeRow | null {
    return this.#snapshot.rows.find((row) => row.path === pathValue) ?? null;
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

function firstFilePath(paths: readonly string[]): string | null {
  return paths.find((item) => item.length > 0 && !item.endsWith("/")) ?? null;
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
    .filter((entry) => entry.name !== ".git")
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
  const trimmed = inputPath.trim().replace(/\\/gu, "/");
  if (!trimmed) return { ok: false, error: "Enter a workspace-relative path." };
  if (path.posix.isAbsolute(trimmed) || path.isAbsolute(trimmed)) {
    return { ok: false, error: "Use a workspace-relative path, not an absolute path." };
  }

  const relativePath = path.posix.normalize(trimmed).replace(/^\.\//u, "");
  if (!relativePath || relativePath === "." || relativePath.startsWith("../")) {
    return { ok: false, error: "Path must stay inside the workspace." };
  }
  if (options.requireFilePath && relativePath.endsWith("/")) {
    return { ok: false, error: "Enter a file path, not a directory path." };
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
