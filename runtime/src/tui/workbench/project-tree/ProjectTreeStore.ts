import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, type Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { globbyStream } from "globby";

import { buildProjectTreeRows } from "./buildTree.js";
import {
  collectGitStatus,
  listGitFiles,
  type GitStatusByPath,
} from "./gitStatus.js";
import { normalizeWorkspacePathForReferences } from "../pathReferences.js";
import type { ProjectTreeRow, ProjectTreeSnapshot } from "../types.js";
import {
  bindWorkspaceDirectoryMutation,
  captureWorkspaceFilePathTransactionGuard,
  WorkspaceFileMutationPreEffectConflictError,
  type WorkspaceBoundDirectoryMutation,
  type WorkspaceFilePathTransactionGuard,
} from "../../../workspace/file-mutation-transaction.js";

type Listener = () => void;
export type ProjectTreeMutationResult =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly error: string;
      /**
       * A destructive filesystem primitive started but did not report success.
       * Callers must reconcile this as an unknown outcome, never as a safe
       * pre-effect cancellation.
       */
      readonly effect?: "unknown";
    };
export type ProjectTreeMutationOptions = {
  /**
   * Synchronous last-moment guard invoked after every preparatory await and
   * before the final path-identity check which precedes the filesystem syscall.
   */
  readonly beforeCommit?: () => string | null;
  /**
   * Deterministic ancestor-exchange seam after the last main-process
   * pathname assertion. The bound helper/descriptor must still prevent escape.
   */
  readonly __testAfterFinalPathCheck?: () => void | Promise<void>;
  /**
   * Deterministic post-syscall race seam for regression tests only. Production
   * callers must omit it.
   */
  readonly __testAfterPathEffect?: () => void | Promise<void>;
};
export type RenamePathNoClobberTestHooks = {
  /**
   * Deterministic race injection used by filesystem regression tests only.
   * Production callers must omit these hooks.
   */
  readonly beforeRenameFailClosed?: () => void | Promise<void>;
};

const EMPTY_SNAPSHOT: ProjectTreeSnapshot = Object.freeze({
  cwd: process.cwd(),
  rows: [],
  loading: true,
  error: null,
  cursorPath: null,
  activePath: null,
  expandedPaths: [],
  fileCount: 0,
  directoryCount: 0,
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
  /**
   * Count of refresh passes currently running. The periodic timer skips its
   * tick while one is active: on a slow workspace a scan can outlive the
   * refresh interval, and without this guard the timer stacks unbounded
   * CONCURRENT scans — each with its own directory-walker queue — leaking
   * memory even though every individual scan is bounded. Direct refresh()
   * calls keep their original racing semantics (the version check already
   * makes the newest result win).
   */
  #refreshActive = 0;
  #refreshTimer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  #mutationWorkspaceRootIdentity: StableDirectoryIdentity | null;
  // Directory paths known at the last successful scan, used to detect directories
  // that newly appeared mid-session (an agent-created subpackage) so they can be
  // auto-revealed. Stays null until the first scan establishes the baseline — the
  // initial repo tree must NOT auto-expand (that would explode a large repo).
  #knownDirectories: ReadonlySet<string> | null = null;

  constructor(cwd = process.cwd(), refreshIntervalMs = 5_000) {
    this.#cwd = cwd;
    this.#refreshIntervalMs = refreshIntervalMs;
    this.#mutationWorkspaceRootIdentity =
      captureInitialWorkspaceRootIdentity(cwd);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.refresh();
    if (this.#refreshIntervalMs > 0) {
      this.#refreshTimer = setInterval(() => {
        // Skip the tick while a pass is still running (see #refreshActive) —
        // a fresh pass right after it finishes reads the same disk state.
        if (this.#refreshActive === 0) void this.refresh();
      }, this.#refreshIntervalMs);
      this.#refreshTimer.unref?.();
    }
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ProjectTreeSnapshot => this.#snapshot;

  getFilePaths(): readonly string[] {
    return this.#paths.filter((item) => item.length > 0 && !item.endsWith("/"));
  }

  hasInFlightPathWithin(pathValue: string): boolean {
    const normalized = normalizeWorkspacePathForReferences(pathValue).replace(
      /\/+$/u,
      "",
    );
    return [...this.#inFlightPaths].some(
      (candidate) =>
        candidate === normalized || candidate.startsWith(`${normalized}/`),
    );
  }

  dispose(): void {
    this.#started = false;
    if (this.#refreshTimer !== null) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    this.#listeners.clear();
  }

  async refresh(): Promise<void> {
    this.#refreshActive += 1;
    try {
      await this.#refreshOnce();
    } finally {
      this.#refreshActive -= 1;
    }
  }

  async #refreshOnce(): Promise<void> {
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
      this.#cursorPath =
        this.#cursorPath ?? firstFilePath(paths) ?? paths[0] ?? null;
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
    const next = Math.max(
      0,
      Math.min(rows.length - 1, (current < 0 ? 0 : current) + delta),
    );
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
      if (
        this.#cursorPath &&
        isDescendantPath(this.#cursorPath, normalizedPath)
      ) {
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
      if (
        this.#cursorPath &&
        isDescendantPath(this.#cursorPath, normalizedPath)
      ) {
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
    return (
      this.#snapshot.rows.find((row) => row.path === this.#cursorPath) ?? null
    );
  }

  async createFile(
    relativePath: string,
    options: ProjectTreeMutationOptions = {},
  ): Promise<ProjectTreeMutationResult> {
    const target = resolveWorkspaceRelativePath(this.#cwd, relativePath, {
      requireFilePath: true,
    });
    if (!target.ok) return target;

    let commitAttempted = false;
    let guard: WorkspaceFilePathTransactionGuard | undefined;
    try {
      if (this.hasInFlightPathWithin(target.relativePath)) {
        return {
          ok: false,
          error: `Cannot create ${target.relativePath} while an agent may be writing to it.`,
        };
      }
      await assertWorkspaceMutationParentContained(
        this.#cwd,
        target.absolutePath,
      );
      guard = await captureWorkspaceFilePathTransactionGuard(
        target.absolutePath,
      );
      if (guard.targetExisted) {
        throw Object.assign(new Error("path already exists"), {
          code: "EEXIST" as const,
        });
      }
      const missingState = { kind: "missing" as const };
      await guard.prepareBoundMutation(missingState, "write");
      if (this.hasInFlightPathWithin(target.relativePath)) {
        return {
          ok: false,
          error: `Cannot create ${target.relativePath} while an agent may be writing to it.`,
        };
      }
      const refusal = options.beforeCommit?.();
      if (refusal) return { ok: false, error: refusal };
      await guard.assertOriginalState();
      await options.__testAfterFinalPathCheck?.();
      await guard.writeBoundContent(missingState, Buffer.alloc(0), () => {
        commitAttempted = true;
      });
      await options.__testAfterPathEffect?.();
      await guard.assertState({
        kind: "content",
        content: Buffer.alloc(0),
      });
      await this.refresh();
      this.reveal(target.relativePath);
      return { ok: true, path: target.relativePath };
    } catch (error) {
      let normalizedError =
        error instanceof WorkspaceFileMutationPreEffectConflictError
          ? Object.assign(new Error("path already exists"), {
              code: "EEXIST" as const,
            })
          : error;
      if (isSharedWorkspacePathIdentityError(normalizedError)) {
        normalizedError =
          !commitAttempted && (await pathExists(target.absolutePath))
            ? Object.assign(new Error("path already exists"), {
                code: "EEXIST" as const,
              })
            : projectTreePathIdentityChangedError(target.absolutePath);
      }
      return {
        ok: false,
        error: fileActionError("create", target.relativePath, normalizedError),
        ...(commitAttempted && mutationErrorMayHaveEffect(normalizedError)
          ? { effect: "unknown" as const }
          : {}),
      };
    } finally {
      await guard?.dispose();
    }
  }

  async renamePath(
    fromPath: string,
    toPath: string,
    options: ProjectTreeMutationOptions = {},
  ): Promise<ProjectTreeMutationResult> {
    const source = resolveWorkspaceRelativePath(this.#cwd, fromPath);
    if (!source.ok) return source;
    const target = resolveWorkspaceRelativePath(this.#cwd, toPath);
    if (!target.ok) return target;

    let commitAttempted = false;
    let directoryMutation: WorkspaceBoundDirectoryMutation | undefined;
    try {
      if (this.hasInFlightPathWithin(source.relativePath)) {
        return {
          ok: false,
          error: `Cannot rename ${source.relativePath} while an agent may be writing inside it.`,
        };
      }
      if (isDescendantPath(target.relativePath, source.relativePath)) {
        return {
          ok: false,
          error: `Cannot rename ${source.relativePath} to ${target.relativePath}: target is inside the source path.`,
        };
      }
      await Promise.all([
        assertWorkspaceMutationParentContained(this.#cwd, source.absolutePath),
        assertWorkspaceMutationParentContained(this.#cwd, target.absolutePath),
      ]);
      if (this.hasInFlightPathWithin(source.relativePath)) {
        return {
          ok: false,
          error: `Cannot rename ${source.relativePath} while an agent may be writing inside it.`,
        };
      }
      if (
        path.dirname(source.absolutePath) !== path.dirname(target.absolutePath)
      ) {
        throw unsupportedPathRenameError(
          source.absolutePath,
          target.absolutePath,
          "Only same-directory regular-file renames can be made identity-bound and no-clobber.",
        );
      }
      if (await pathExists(target.absolutePath)) {
        return {
          ok: false,
          error: `Cannot rename to ${target.relativePath}: path already exists.`,
        };
      }
      const workspaceRootIdentity =
        await this.#getMutationWorkspaceRootIdentity();
      const sourceIdentity = await captureDeletePathIdentity(
        workspaceRootIdentity,
        source.relativePath,
      );
      if (sourceIdentity.target.kind !== "file") {
        throw unsupportedPathRenameError(
          source.absolutePath,
          target.absolutePath,
          "Directory and symlink rename still lack a portable identity-bound no-clobber destination primitive.",
        );
      }
      const targetIdentity = await captureCreatePathIdentity(
        workspaceRootIdentity,
        target.relativePath,
      );
      directoryMutation = await bindWorkspaceDirectoryMutation({
        parent: sourceIdentity.parent,
        targetPath: sourceIdentity.targetPath,
      });
      const refusal = options.beforeCommit?.();
      if (refusal) return { ok: false, error: refusal };
      await assertDeletePathIdentity(sourceIdentity);
      await assertCreatePathIdentity(targetIdentity);
      await options.__testAfterFinalPathCheck?.();
      const renamedIdentity = await directoryMutation.renameRegularFile(
        path.basename(target.absolutePath),
        sourceIdentity.target,
        () => {
          commitAttempted = true;
        },
      );
      await options.__testAfterPathEffect?.();
      await assertMissingTarget(sourceIdentity, { staleIfPresent: true });
      const observedTarget = await observeRegularFileIdentity(
        target.absolutePath,
      );
      if (
        renamedIdentity.dev !== observedTarget.dev ||
        renamedIdentity.ino !== observedTarget.ino ||
        !sameRenamedRegularFileIdentity(sourceIdentity.target, observedTarget)
      ) {
        throw projectTreePathIdentityChangedError(target.absolutePath);
      }
      await this.refresh();
      this.reveal(target.relativePath);
      return { ok: true, path: target.relativePath };
    } catch (error) {
      let normalizedError =
        error instanceof WorkspaceFileMutationPreEffectConflictError
          ? Object.assign(new Error("path already exists"), {
              code: "EEXIST" as const,
            })
          : error;
      if (isSharedWorkspacePathIdentityError(normalizedError)) {
        normalizedError = projectTreePathIdentityChangedError(
          source.absolutePath,
        );
      }
      return {
        ok: false,
        error: fileActionError("rename", source.relativePath, normalizedError),
        ...(commitAttempted && mutationErrorMayHaveEffect(normalizedError)
          ? { effect: "unknown" as const }
          : {}),
      };
    } finally {
      await directoryMutation?.dispose();
    }
  }

  async deletePath(
    relativePath: string,
    options: ProjectTreeMutationOptions = {},
  ): Promise<ProjectTreeMutationResult> {
    const target = resolveWorkspaceRelativePath(this.#cwd, relativePath);
    if (!target.ok) return target;

    let commitAttempted = false;
    let fileGuard: WorkspaceFilePathTransactionGuard | undefined;
    let directoryMutation: WorkspaceBoundDirectoryMutation | undefined;
    try {
      if (this.hasInFlightPathWithin(target.relativePath)) {
        return {
          ok: false,
          error: `Cannot delete ${target.relativePath} while an agent may be writing inside it.`,
        };
      }
      await assertWorkspaceMutationParentContained(
        this.#cwd,
        target.absolutePath,
      );
      const workspaceRootIdentity =
        await this.#getMutationWorkspaceRootIdentity();
      const pathIdentity = await captureDeletePathIdentity(
        workspaceRootIdentity,
        target.relativePath,
      );
      if (pathIdentity.target.kind === "file") {
        fileGuard = await captureWorkspaceFilePathTransactionGuard(
          target.absolutePath,
        );
        if (
          !fileGuard.targetExisted ||
          fileGuard.backupContent === undefined ||
          sha256Buffer(fileGuard.backupContent) !==
            pathIdentity.target.contentSha256
        ) {
          throw projectTreePathIdentityChangedError(target.absolutePath);
        }
        await fileGuard.prepareBoundMutation(
          { kind: "content", content: fileGuard.backupContent },
          "remove",
        );
      } else {
        directoryMutation = await bindWorkspaceDirectoryMutation({
          parent: pathIdentity.parent,
          targetPath: pathIdentity.targetPath,
        });
      }
      const refusal = options.beforeCommit?.();
      if (refusal) return { ok: false, error: refusal };
      await assertDeletePathIdentity(pathIdentity);
      await options.__testAfterFinalPathCheck?.();
      const markEffectStarted = (): void => {
        commitAttempted = true;
      };
      if (pathIdentity.target.kind === "file") {
        await fileGuard!.removeBoundEntry(
          {
            kind: "content",
            content: fileGuard!.backupContent!,
          },
          markEffectStarted,
        );
      } else if (pathIdentity.target.kind === "symlink") {
        await directoryMutation!.removeSymlink(
          pathIdentity.target,
          pathIdentity.target.linkTarget,
          markEffectStarted,
        );
      } else {
        await directoryMutation!.removeDirectory(
          pathIdentity.target,
          markEffectStarted,
        );
      }
      await options.__testAfterPathEffect?.();
      await assertDeletedPathIdentity(pathIdentity);
      this.#deleteExpandedPaths(target.relativePath);
      await this.refresh();
      this.reveal(parentPath(target.relativePath));
      return { ok: true, path: target.relativePath };
    } catch (error) {
      const normalizedError = isSharedWorkspacePathIdentityError(error)
        ? projectTreePathIdentityChangedError(target.absolutePath)
        : error;
      return {
        ok: false,
        error: fileActionError("delete", target.relativePath, normalizedError),
        ...(commitAttempted && mutationErrorMayHaveEffect(normalizedError)
          ? { effect: "unknown" as const }
          : {}),
      };
    } finally {
      await fileGuard?.dispose();
      await directoryMutation?.dispose();
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

  #deleteExpandedPaths(pathValue: string): void {
    for (const expandedPath of [...this.#expandedPaths]) {
      if (
        expandedPath === pathValue ||
        isDescendantPath(expandedPath, pathValue)
      ) {
        this.#expandedPaths.delete(expandedPath);
      }
    }
  }

  async #getMutationWorkspaceRootIdentity(): Promise<StableDirectoryIdentity> {
    const existing = this.#mutationWorkspaceRootIdentity;
    if (existing !== null) return existing;
    const canonicalRoot = await realpath(path.resolve(this.#cwd));
    const captured = await observeStableDirectoryIdentity(canonicalRoot);
    this.#mutationWorkspaceRootIdentity = captured;
    return captured;
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
    const visibleRows =
      normalizedCursorPath === this.#cursorPath
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
      directoryCount: collectDirectoryPaths(this.#paths).size,
    };
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Move one workspace path without ever authorizing replacement from a prior
 * existence check.
 *
 * All moves fail closed before mutation. Node exposes neither identity-bound
 * source removal nor portable exclusive rename flags, and check-then-unlink or
 * check-then-rename protocols remain vulnerable to source or target name
 * replacement races.
 */
export async function renamePathNoClobber(
  sourcePath: string,
  targetPath: string,
  testHooks: RenamePathNoClobberTestHooks = {},
): Promise<void> {
  const source = path.resolve(sourcePath).normalize("NFC");
  const target = path.resolve(targetPath).normalize("NFC");
  if (path.dirname(source) !== path.dirname(target)) {
    throw unsupportedPathRenameError(source, target);
  }
  const parent = await observeStableDirectoryIdentity(path.dirname(source));
  const sourceStats = await lstat(source);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw unsupportedPathRenameError(
      source,
      target,
      "Directory and symlink rename still lack a portable identity-bound no-clobber destination primitive.",
    );
  }
  const sourceIdentity = await observeRegularFileIdentity(source);
  if (sourceIdentity.kind !== "file") {
    throw unsupportedPathRenameError(source, target);
  }
  if (await pathExists(target)) {
    throw Object.assign(new Error("path already exists"), {
      code: "EEXIST" as const,
    });
  }
  const mutation = await bindWorkspaceDirectoryMutation({
    parent,
    targetPath: source,
  });
  try {
    await testHooks.beforeRenameFailClosed?.();
    await assertStableDirectoryIdentity(parent, source);
    const currentSource = await observeRegularFileIdentity(source);
    if (
      currentSource.kind !== "file" ||
      !sameDeleteTargetIdentity(sourceIdentity, currentSource) ||
      (await pathExists(target))
    ) {
      throw projectTreePathIdentityChangedError(source);
    }
    await mutation.renameRegularFile(path.basename(target), sourceIdentity);
    const targetIdentity = await observeRegularFileIdentity(target);
    if (
      targetIdentity.kind !== "file" ||
      !sameRenamedRegularFileIdentity(sourceIdentity, targetIdentity)
    ) {
      throw projectTreePathIdentityChangedError(target);
    }
  } finally {
    await mutation.dispose();
  }
}

function unsupportedPathRenameError(
  sourcePath: string,
  targetPath: string,
  reason = "Only same-directory regular-file renames can currently be made identity-bound and no-clobber.",
): Error & { readonly code: string } {
  return Object.assign(
    new Error(
      `Atomic identity-bound no-clobber rename from ${sourcePath} to ${targetPath} is unavailable. ${reason} Close Editor and use trusted external tooling for other moves.`,
    ),
    { code: "ENOTSUP" as const },
  );
}

function isFsErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

let singleton: ProjectTreeStore | null = null;

export function getProjectTreeStore(): ProjectTreeStore {
  singleton ??= new ProjectTreeStore();
  return singleton;
}

function selectableRows(
  rows: readonly ProjectTreeRow[],
): readonly ProjectTreeRow[] {
  return rows.filter((row) => row.kind === "file" || row.kind === "directory");
}

function visibleCursorPath(
  cursorPath: string | null,
  rows: readonly ProjectTreeRow[],
): string | null {
  const selectable = selectableRows(rows);
  if (selectable.length === 0) return null;
  if (cursorPath && selectable.some((row) => row.path === cursorPath))
    return cursorPath;

  let parent = cursorPath ? parentPath(cursorPath) : null;
  while (parent !== null) {
    const visibleParent = selectable.find((row) => row.path === parent);
    if (visibleParent) return visibleParent.path;
    parent = parentPath(parent);
  }

  return selectable[0]?.path ?? cursorPath;
}

function sameSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function normalizeProjectTreeReference(
  pathValue: string | null,
): string | null {
  return pathValue === null
    ? null
    : normalizeWorkspacePathForReferences(pathValue);
}

function normalizedPathSet(paths: Iterable<string>): Set<string> {
  return new Set(
    [...paths].map((pathValue) =>
      normalizeWorkspacePathForReferences(pathValue),
    ),
  );
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
    const lastDirectoryIndex = isDirectoryEntry
      ? segments.length
      : segments.length - 1;
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
  return (
    value.length > possibleAncestor.length &&
    value.startsWith(`${possibleAncestor}/`)
  );
}

async function readTopLevelPaths(cwd: string): Promise<string[]> {
  const entries = await readdir(cwd, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        !(
          entry.isDirectory() &&
          WORKSPACE_TREE_IGNORED_DIRECTORY_NAMES.has(entry.name)
        ),
    )
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function listWorkspacePaths(cwd: string): Promise<string[]> {
  const gitPaths = await listGitFiles(cwd);
  if (gitPaths && gitPaths.length > 0) return gitPaths;

  const scannedPaths = await scanWorkspacePaths(cwd);
  if (scannedPaths.length > 0) return scannedPaths;

  return readTopLevelPaths(cwd);
}

/**
 * Hard bounds for the fallback workspace scan (non-git workspaces only — git
 * repos list files via `git ls-files`, which is fast and already bounded by
 * the repo).
 *
 * The scan MUST be bounded: a user launching agenc from a huge cwd (e.g.
 * `$HOME`, millions of entries under ~/Library and project node_modules)
 * previously ran an unbounded `globby("**\/*")` here. The walker's internal
 * queue (fast-glob → @nodelib/fs.walk → fastq) produced entries faster than
 * the ignore-matcher consumed them and retained every result, ballooning the
 * heap to the V8 limit in minutes — a field OOM traced back here via heap
 * snapshot (millions of queued fastq Tasks + hundreds of thousands of
 * Dirents). The project tree is a UI convenience; it is never allowed to
 * take the process down.
 */
export const WORKSPACE_SCAN_MAX_ENTRIES = 10_000;
export const WORKSPACE_SCAN_MAX_DEPTH = 8;

export async function scanWorkspacePaths(
  cwd: string,
  limits: {
    readonly maxEntries?: number;
    readonly maxDepth?: number;
  } = {},
): Promise<string[]> {
  const maxEntries = limits.maxEntries ?? WORKSPACE_SCAN_MAX_ENTRIES;
  const maxDepth = limits.maxDepth ?? WORKSPACE_SCAN_MAX_DEPTH;
  const stream = globbyStream(["**/*"], {
    cwd,
    deep: maxDepth,
    dot: true,
    // NO gitignore semantics here: this fallback only runs for NON-git
    // workspaces (git repos list via `git ls-files`), and globby implements
    // `gitignore: true` by first running its own `**/.gitignore` glob over
    // the whole cwd — an unbounded walk that ignores `deep`/our entry cap
    // and re-introduces the very OOM this scan was bounded to prevent.
    gitignore: false,
    ignore: [...WORKSPACE_TREE_IGNORE],
    objectMode: true,
    onlyFiles: false,
    unique: true,
    // Best-effort UI tree: a permission-denied directory (macOS TCC dirs
    // like ~/Pictures/Photo Booth Library, ~/Library) must be SKIPPED. The
    // buffered globby() surfaced these as a promise rejection that refresh()
    // caught; the stream re-exposes them as an unhandled 'error' event that
    // would crash the whole TUI — and skipping is also strictly better than
    // the old behavior of erroring the tree on the first unreadable dir.
    suppressErrors: true,
  });

  const paths: string[] = [];
  for await (const entry of stream as AsyncIterable<{
    path: string;
    dirent: { isDirectory(): boolean };
  }>) {
    paths.push(normalizeScannedPath(entry.path, entry.dirent.isDirectory()));
    if (paths.length >= maxEntries) {
      // Breaking out of for-await destroys the stream, which tears down the
      // underlying directory walker and frees its queue.
      break;
    }
  }

  return paths.filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function normalizeScannedPath(pathValue: string, isDirectory: boolean): string {
  const normalized = pathValue.split(path.sep).join("/");
  return isDirectory ? `${normalized}/` : normalized;
}

function resolveWorkspaceRelativePath(
  cwd: string,
  inputPath: string,
  options: { readonly requireFilePath?: boolean } = {},
):
  | {
      readonly ok: true;
      readonly relativePath: string;
      readonly absolutePath: string;
    }
  | { readonly ok: false; readonly error: string } {
  const input = inputPath.replace(/\\/gu, "/");
  if (input.trim().length === 0)
    return { ok: false, error: "Enter a workspace-relative path." };
  if (
    isWindowsDriveQualifiedPath(input) ||
    path.posix.isAbsolute(input) ||
    path.isAbsolute(input)
  ) {
    return {
      ok: false,
      error: "Use a workspace-relative path, not an absolute path.",
    };
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
  const rootWithSeparator = root.endsWith(path.sep)
    ? root
    : `${root}${path.sep}`;
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

interface StableDirectoryIdentity {
  readonly path: string;
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

interface ProjectTreeMutationPathIdentity {
  readonly targetPath: string;
  readonly workspaceRoot: StableDirectoryIdentity;
  readonly parent: StableDirectoryIdentity;
}

type ProjectTreeCreatePathIdentity = ProjectTreeMutationPathIdentity;

type ProjectTreeDeleteTargetIdentity =
  | {
      readonly kind: "file";
      readonly dev: number;
      readonly ino: number;
      readonly mode: number;
      readonly size: number;
      readonly mtimeMs: number;
      readonly ctimeMs: number;
      readonly contentSha256: string;
    }
  | {
      readonly kind: "symlink";
      readonly dev: number;
      readonly ino: number;
      readonly mode: number;
      readonly linkTarget: string;
    }
  | {
      readonly kind: "directory";
      readonly dev: number;
      readonly ino: number;
      readonly mode: number;
    };

interface ProjectTreeDeletePathIdentity extends ProjectTreeMutationPathIdentity {
  readonly target: ProjectTreeDeleteTargetIdentity;
}

function captureInitialWorkspaceRootIdentity(
  cwd: string,
): StableDirectoryIdentity | null {
  try {
    const canonicalRoot = realpathSync(path.resolve(cwd)).normalize("NFC");
    const before = lstatSync(canonicalRoot);
    const observedRealPath = realpathSync(canonicalRoot).normalize("NFC");
    const after = lstatSync(canonicalRoot);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !sameFilesystemIdentity(before, after) ||
      observedRealPath !== canonicalRoot
    ) {
      return null;
    }
    return {
      path: canonicalRoot,
      realPath: observedRealPath,
      dev: after.dev,
      ino: after.ino,
      mode: after.mode,
    };
  } catch {
    return null;
  }
}

function sameFilesystemIdentity(
  left: Pick<Stats, "dev" | "ino" | "mode">,
  right: Pick<Stats, "dev" | "ino" | "mode">,
): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  );
}

function projectTreePathIdentityChangedError(
  targetPath: string,
): Error & { readonly code: "ESTALE" } {
  return Object.assign(
    new Error(
      `filesystem path identity changed across the operation boundary for ${targetPath}; no further pathname mutation was authorized`,
    ),
    { code: "ESTALE" as const },
  );
}

function unsupportedCreateParentError(
  targetPath: string,
): Error & { readonly code: "ENOTSUP" } {
  return Object.assign(
    new Error(
      `the parent directory for ${targetPath} does not exist. Create the directory first, then retry the file creation; recursive parent creation cannot be made identity-bound with portable Node filesystem APIs`,
    ),
    { code: "ENOTSUP" as const },
  );
}

async function observeStableDirectoryIdentity(
  expectedPath: string,
): Promise<StableDirectoryIdentity> {
  const normalizedPath = path.resolve(expectedPath).normalize("NFC");
  const before = await lstat(normalizedPath);
  const observedRealPath = (await realpath(normalizedPath)).normalize("NFC");
  const after = await lstat(normalizedPath);
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !sameFilesystemIdentity(before, after) ||
    observedRealPath !== normalizedPath
  ) {
    throw projectTreePathIdentityChangedError(normalizedPath);
  }
  return {
    path: normalizedPath,
    realPath: observedRealPath,
    dev: after.dev,
    ino: after.ino,
    mode: after.mode,
  };
}

async function assertStableDirectoryIdentity(
  identity: StableDirectoryIdentity,
  targetPath: string,
): Promise<void> {
  let observed: StableDirectoryIdentity;
  try {
    observed = await observeStableDirectoryIdentity(identity.path);
  } catch {
    throw projectTreePathIdentityChangedError(targetPath);
  }
  if (
    observed.realPath !== identity.realPath ||
    observed.dev !== identity.dev ||
    observed.ino !== identity.ino ||
    observed.mode !== identity.mode
  ) {
    throw projectTreePathIdentityChangedError(targetPath);
  }
}

function resolvePinnedWorkspaceMutationTarget(
  workspaceRoot: StableDirectoryIdentity,
  relativePath: string,
): string {
  const targetPath = path
    .resolve(workspaceRoot.path, relativePath)
    .normalize("NFC");
  const relativeTarget = path.relative(workspaceRoot.path, targetPath);
  if (
    relativeTarget === "" ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw projectTreePathIdentityChangedError(targetPath);
  }
  return targetPath;
}

async function captureMutationPathIdentity(
  workspaceRoot: StableDirectoryIdentity,
  relativePath: string,
  options: { readonly create: boolean },
): Promise<ProjectTreeMutationPathIdentity> {
  const targetPath = resolvePinnedWorkspaceMutationTarget(
    workspaceRoot,
    relativePath,
  );
  await assertStableDirectoryIdentity(workspaceRoot, targetPath);
  let parent: StableDirectoryIdentity;
  try {
    parent = await observeStableDirectoryIdentity(path.dirname(targetPath));
  } catch (error) {
    if (options.create && isNodeError(error) && error.code === "ENOENT") {
      throw unsupportedCreateParentError(targetPath);
    }
    throw error;
  }
  await assertStableDirectoryIdentity(workspaceRoot, targetPath);
  return {
    targetPath,
    workspaceRoot,
    parent,
  };
}

async function assertMutationPathDirectories(
  identity: ProjectTreeMutationPathIdentity,
): Promise<void> {
  await assertStableDirectoryIdentity(
    identity.workspaceRoot,
    identity.targetPath,
  );
  if (identity.parent.path !== identity.workspaceRoot.path) {
    await assertStableDirectoryIdentity(identity.parent, identity.targetPath);
  }
}

async function assertMissingTarget(
  identity: ProjectTreeMutationPathIdentity,
  options: { readonly staleIfPresent: boolean },
): Promise<void> {
  await assertMutationPathDirectories(identity);
  try {
    await lstat(identity.targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await assertMutationPathDirectories(identity);
      return;
    }
    throw error;
  }
  if (options.staleIfPresent) {
    throw projectTreePathIdentityChangedError(identity.targetPath);
  }
  throw Object.assign(new Error("path already exists"), {
    code: "EEXIST" as const,
  });
}

async function captureCreatePathIdentity(
  workspaceRoot: StableDirectoryIdentity,
  relativePath: string,
): Promise<ProjectTreeCreatePathIdentity> {
  const identity = await captureMutationPathIdentity(
    workspaceRoot,
    relativePath,
    {
      create: true,
    },
  );
  await assertMissingTarget(identity, { staleIfPresent: false });
  return identity;
}

async function assertCreatePathIdentity(
  identity: ProjectTreeCreatePathIdentity,
): Promise<void> {
  await assertMissingTarget(identity, { staleIfPresent: false });
}

async function sha256FileHandle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      position,
    );
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function sha256Buffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function observeRegularFileIdentity(
  targetPath: string,
): Promise<ProjectTreeDeleteTargetIdentity> {
  const before = await lstat(targetPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw projectTreePathIdentityChangedError(targetPath);
  }
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle: FileHandle | null = null;
  try {
    handle = await open(targetPath, flags);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFilesystemIdentity(before, opened)) {
      throw projectTreePathIdentityChangedError(targetPath);
    }
    const contentSha256 = await sha256FileHandle(handle);
    const afterRead = await handle.stat();
    const afterPath = await lstat(targetPath);
    if (
      !afterRead.isFile() ||
      !afterPath.isFile() ||
      !sameFilesystemIdentity(opened, afterRead) ||
      !sameFilesystemIdentity(afterRead, afterPath) ||
      opened.size !== afterRead.size ||
      opened.mtimeMs !== afterRead.mtimeMs ||
      opened.ctimeMs !== afterRead.ctimeMs
    ) {
      throw projectTreePathIdentityChangedError(targetPath);
    }
    return {
      kind: "file",
      dev: afterRead.dev,
      ino: afterRead.ino,
      mode: afterRead.mode,
      size: afterRead.size,
      mtimeMs: afterRead.mtimeMs,
      ctimeMs: afterRead.ctimeMs,
      contentSha256,
    };
  } finally {
    await handle?.close();
  }
}

async function observeSymlinkIdentity(
  targetPath: string,
): Promise<ProjectTreeDeleteTargetIdentity> {
  const before = await lstat(targetPath);
  if (!before.isSymbolicLink()) {
    throw projectTreePathIdentityChangedError(targetPath);
  }
  const linkTarget = await readlink(targetPath);
  const after = await lstat(targetPath);
  if (!after.isSymbolicLink() || !sameFilesystemIdentity(before, after)) {
    throw projectTreePathIdentityChangedError(targetPath);
  }
  return {
    kind: "symlink",
    dev: after.dev,
    ino: after.ino,
    mode: after.mode,
    linkTarget,
  };
}

async function observeDeleteTargetIdentity(
  targetPath: string,
): Promise<ProjectTreeDeleteTargetIdentity> {
  const observed = await lstat(targetPath);
  if (observed.isDirectory() && !observed.isSymbolicLink()) {
    return {
      kind: "directory",
      dev: observed.dev,
      ino: observed.ino,
      mode: observed.mode,
    };
  }
  if (observed.isFile() && !observed.isSymbolicLink()) {
    return observeRegularFileIdentity(targetPath);
  }
  if (observed.isSymbolicLink()) {
    return observeSymlinkIdentity(targetPath);
  }
  throw Object.assign(
    new Error(
      `identity-bound deletion is unavailable for this filesystem object at ${targetPath}`,
    ),
    { code: "ENOTSUP" as const },
  );
}

function sameDeleteTargetIdentity(
  expected: ProjectTreeDeleteTargetIdentity,
  observed: ProjectTreeDeleteTargetIdentity,
): boolean {
  if (expected.kind !== observed.kind) return false;
  if (
    expected.dev !== observed.dev ||
    expected.ino !== observed.ino ||
    expected.mode !== observed.mode
  ) {
    return false;
  }
  if (expected.kind === "file" && observed.kind === "file") {
    return (
      expected.size === observed.size &&
      expected.mtimeMs === observed.mtimeMs &&
      expected.ctimeMs === observed.ctimeMs &&
      expected.contentSha256 === observed.contentSha256
    );
  }
  return (
    (expected.kind === "symlink" &&
      observed.kind === "symlink" &&
      expected.linkTarget === observed.linkTarget) ||
    (expected.kind === "directory" && observed.kind === "directory")
  );
}

function sameRenamedRegularFileIdentity(
  expected: ProjectTreeDeleteTargetIdentity,
  observed: ProjectTreeDeleteTargetIdentity,
): boolean {
  return (
    expected.kind === "file" &&
    observed.kind === "file" &&
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.mode === observed.mode &&
    expected.size === observed.size &&
    expected.mtimeMs === observed.mtimeMs &&
    expected.contentSha256 === observed.contentSha256
  );
}

function isSharedWorkspacePathIdentityError(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "WorkspacePathIdentityChangedError"
  );
}

async function captureDeletePathIdentity(
  workspaceRoot: StableDirectoryIdentity,
  relativePath: string,
): Promise<ProjectTreeDeletePathIdentity> {
  const identity = await captureMutationPathIdentity(
    workspaceRoot,
    relativePath,
    {
      create: false,
    },
  );
  await assertMutationPathDirectories(identity);
  const target = await observeDeleteTargetIdentity(identity.targetPath);
  await assertMutationPathDirectories(identity);
  return { ...identity, target };
}

async function assertDeletePathIdentity(
  identity: ProjectTreeDeletePathIdentity,
): Promise<void> {
  await assertMutationPathDirectories(identity);
  let observed: ProjectTreeDeleteTargetIdentity;
  try {
    observed = await observeDeleteTargetIdentity(identity.targetPath);
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOTSUP" || error.code === "ENOENT")
    ) {
      throw projectTreePathIdentityChangedError(identity.targetPath);
    }
    throw error;
  }
  if (!sameDeleteTargetIdentity(identity.target, observed)) {
    throw projectTreePathIdentityChangedError(identity.targetPath);
  }
  await assertMutationPathDirectories(identity);
}

async function assertDeletedPathIdentity(
  identity: ProjectTreeDeletePathIdentity,
): Promise<void> {
  await assertMissingTarget(identity, { staleIfPresent: true });
}

async function assertWorkspaceMutationParentContained(
  cwd: string,
  absolutePath: string,
): Promise<void> {
  const canonicalRoot = await realpath(path.resolve(cwd));
  let candidate = path.dirname(absolutePath);
  let canonicalParent: string | null = null;
  for (;;) {
    try {
      canonicalParent = await realpath(candidate);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  if (canonicalParent === null) {
    throw new Error("cannot verify the workspace mutation parent directory");
  }
  const relativeParent = path.relative(canonicalRoot, canonicalParent);
  if (
    relativeParent === ".." ||
    relativeParent.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeParent)
  ) {
    throw new Error(
      "path resolves outside the workspace through a symbolic link",
    );
  }
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

function fileActionError(
  action: string,
  relativePath: string,
  error: unknown,
): string {
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

function mutationErrorMayHaveEffect(error: unknown): boolean {
  return !isFsErrorCode(error, "EEXIST") && !isFsErrorCode(error, "ENOENT");
}
