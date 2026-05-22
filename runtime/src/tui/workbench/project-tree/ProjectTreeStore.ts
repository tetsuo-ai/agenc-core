import { readdir } from "node:fs/promises";
import path from "node:path";

import { buildProjectTreeRows, visibleTreePaths } from "./buildTree.js";
import { collectGitStatus, listGitFiles, type GitStatusByPath } from "./gitStatus.js";
import type { ProjectTreeRow, ProjectTreeSnapshot } from "../types.js";

type Listener = () => void;

const EMPTY_SNAPSHOT: ProjectTreeSnapshot = Object.freeze({
  cwd: process.cwd(),
  rows: [],
  loading: true,
  error: null,
  cursorPath: null,
  activePath: null,
  expandedPaths: [],
});

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
        listGitFiles(this.#cwd).then((gitPaths) => gitPaths ?? readTopLevelPaths(this.#cwd)),
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

  move(delta: number): void {
    const rows = selectableRows(this.#snapshot.rows);
    if (rows.length === 0) return;
    const current = rows.findIndex((row) => row.path === this.#cursorPath);
    const next = Math.max(0, Math.min(rows.length - 1, (current < 0 ? 0 : current) + delta));
    this.#cursorPath = rows[next]?.path ?? this.#cursorPath;
    this.#emit();
  }

  movePage(delta: number): void {
    this.move(delta * 10);
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
    if (this.#expandedPaths.has(pathValue)) {
      this.#expandedPaths.delete(pathValue);
    } else {
      this.#expandedPaths.add(pathValue);
    }
    this.#emit();
  }

  expand(pathValue = this.#cursorPath): void {
    if (!pathValue) return;
    this.#expandedPaths.add(pathValue);
    this.#emit();
  }

  collapse(pathValue = this.#cursorPath): void {
    if (!pathValue) return;
    if (this.#expandedPaths.has(pathValue)) {
      this.#expandedPaths.delete(pathValue);
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

  #emit(): void {
    this.#snapshot = {
      cwd: this.#cwd,
      rows: buildProjectTreeRows({
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
      }),
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

async function readTopLevelPaths(cwd: string): Promise<string[]> {
  const entries = await readdir(cwd, { withFileTypes: true });
  return entries
    .filter((entry) => entry.name !== ".git")
    .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
    .sort((a, b) => a.localeCompare(b));
}
