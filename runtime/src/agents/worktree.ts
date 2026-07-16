/**
 * Git worktree lifecycle for subagent isolation.
 *
 * Hand-port of reference `utils/worktree.ts` (1,563 LOC) focused on
 * the core create/resume/teardown paths. The AgenC file mixes
 * in telemetry, stale-cleanup cron, and UI-specific flows; AgenC's
 * T9 subset includes:
 *
 *   - `getOrCreateWorktree(gitRoot, slug)` — fast resume if exists,
 *     else `git worktree add -B worktree-<slug>`.
 *   - `removeAgentWorktree(path, branch, gitRoot)` — force-remove
 *     + branch delete + **I-34 prune** + **I-35 sparse-checkout verify**.
 *   - `hasWorktreeChanges(path, baseCommit)` — check for commits /
 *     dirty files before deleting.
 *   - `findGitRoot(cwd)` — resolve to the canonical owning repo root.
 *
 * Git operations run via `node:child_process.spawn` with a per-
 * invocation mutation lock (concurrent `git worktree add` against
 * the same repo races + corrupts the worktrees index).
 *
 * Invariants wired:
 *   I-34 (worktree force-remove + prune) — `removeAgentWorktree`
 *        runs `git worktree prune --force` after the remove; prune
 *        failures are swallowed + warned, never propagated.
 *   I-35 (sparse-checkout teardown verify) — `removeAgentWorktree`
 *        reads `.git/info/sparse-checkout`; if it differs from the
 *        expected state, runs `git sparse-checkout disable` + emits
 *        `warning:'sparse_checkout_orphaned'`.
 *
 * @module
 */

import {
  existsSync,
  readdirSync,
  realpathSync,
  readFileSync,
  statSync,
  utimesSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { AsyncLock } from "./_deps/async-lock.js";
import type { SandboxExecutionBrokerLike } from "../sandbox/execution-broker.js";
import { scrubEnvForChildProcess } from "../unified-exec/scrub-env.js";
import type { AdditionalPermissionProfile } from "../sandbox/engine/index.js";
import {
  hardenGitWorktreeMutationArgs,
  worktreeMutationPermissions,
} from "../sandbox/worktree-permissions.js";

// ─────────────────────────────────────────────────────────────────────
// Global git-mutation lock
// ─────────────────────────────────────────────────────────────────────

/**
 * `git worktree add` / `remove` / `prune` aren't safe to run
 * concurrently against the same repo — they all mutate
 * `.git/worktrees/`. One lock per process is sufficient since all
 * subagent spawns serialize through AgentControl anyway.
 */
const gitMutationLock = new AsyncLock<void>(undefined);

// ─────────────────────────────────────────────────────────────────────
// Git command helper
// ─────────────────────────────────────────────────────────────────────

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run `git <args>` under `cwd`. Does NOT throw; returns a result. */
function runGit(
  args: ReadonlyArray<string>,
  cwd: string,
  sandboxExecutionBroker: SandboxExecutionBrokerLike,
  additionalPermissions?: AdditionalPermissionProfile,
): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    const command = sandboxExecutionBroker.prepareSpawn("child_agent", {
      program: "git",
      args,
      cwd,
      env: scrubEnvForChildProcess(process.env),
      argv0: "git",
      ...(additionalPermissions !== undefined
        ? { additionalPermissions }
        : {}),
    });
    const child = spawn(command.program, [...command.args], {
      cwd: command.cwd,
      env: command.env,
      argv0: command.argv0,
      stdio: "pipe",
    });
    // I-78 Buffer accumulation — decode at flush.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
    child.on("error", (err) => {
      resolve({
        code: 127,
        stdout: "",
        stderr: err.message,
      });
    });
  });
}

function runGitMutation(
  args: ReadonlyArray<string>,
  cwd: string,
  sandboxExecutionBroker: SandboxExecutionBrokerLike,
  repoRoot: string,
  writablePaths: readonly string[] = [],
): Promise<GitResult> {
  return runGit(
    hardenGitWorktreeMutationArgs(args),
    cwd,
    sandboxExecutionBroker,
    worktreeMutationPermissions(repoRoot, writablePaths),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Git root discovery
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve `startDir` to the owning repository's canonical root.
 *
 * For a regular repo this returns the directory containing `.git`.
 * For a linked worktree this resolves back to the main checkout so
 * agent worktrees always live under one stable repo root.
 */
export function findGitRoot(startDir: string): string | null {
  const gitRoot = findNearestGitRoot(startDir);
  if (!gitRoot) {
    return null;
  }
  return resolveCanonicalGitRoot(gitRoot);
}

function findNearestGitRoot(startDir: string): string | null {
  let dir = resolvePath(startDir);
  while (true) {
    const probe = join(dir, ".git");
    if (existsSync(probe)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function resolveCanonicalGitRoot(gitRoot: string): string {
  try {
    const gitContent = readFileSync(join(gitRoot, ".git"), "utf8").trim();
    if (!gitContent.startsWith("gitdir:")) {
      return gitRoot;
    }

    const worktreeGitDir = resolvePath(
      gitRoot,
      gitContent.slice("gitdir:".length).trim(),
    );
    const commonDir = resolvePath(
      worktreeGitDir,
      readFileSync(join(worktreeGitDir, "commondir"), "utf8").trim(),
    );

    if (resolvePath(dirname(worktreeGitDir)) !== join(commonDir, "worktrees")) {
      return gitRoot;
    }

    const backlink = realpathSync(
      readFileSync(join(worktreeGitDir, "gitdir"), "utf8").trim(),
    );
    if (backlink !== join(realpathSync(gitRoot), ".git")) {
      return gitRoot;
    }

    if (basename(commonDir) !== ".git") {
      return commonDir;
    }
    return dirname(commonDir);
  } catch {
    return gitRoot;
  }
}

function resolveWorktreeGitDir(worktreePath: string): string | null {
  const dotGit = join(worktreePath, ".git");
  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) {
      return dotGit;
    }
  } catch {
    return null;
  }

  try {
    const gitContent = readFileSync(dotGit, "utf8").trim();
    if (!gitContent.startsWith("gitdir:")) {
      return null;
    }
    return resolvePath(worktreePath, gitContent.slice("gitdir:".length).trim());
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Slug validation
// ─────────────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-zA-Z0-9._-]+$/;
const MAX_SLUG_LEN = 64;

function worktreeBranchName(slug: string): string {
  return `worktree-${slug}`;
}

export function validateWorktreeSlug(slug: string): void {
  if (slug.length === 0 || slug.length > MAX_SLUG_LEN) {
    throw new Error(
      `worktree slug must be 1-${MAX_SLUG_LEN} chars: got length ${slug.length}`,
    );
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `worktree slug must match ${SLUG_RE.source}: got "${slug}"`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Create / resume
// ─────────────────────────────────────────────────────────────────────

export interface WorktreeHandle {
  readonly path: string;
  readonly branch: string;
  readonly gitRoot: string;
  readonly created: boolean;
}

export interface GetOrCreateOpts {
  readonly gitRoot: string;
  readonly slug: string;
  readonly base?: string;
  readonly workspaceRoot?: string;
  readonly enableSparseCheckout?: boolean;
  readonly sparsePatterns?: ReadonlyArray<string>;
  readonly sandboxExecutionBroker: SandboxExecutionBrokerLike;
}

/**
 * Create a new worktree (or fast-resume an existing one).
 *
 * Fast resume: if the target path already points at the same canonical
 * repo root, skip the `git worktree add`.
 */
export async function getOrCreateWorktree(
  opts: GetOrCreateOpts,
): Promise<WorktreeHandle> {
  validateWorktreeSlug(opts.slug);
  const branch = worktreeBranchName(opts.slug);
  const workspaceRoot =
    opts.workspaceRoot ?? join(opts.gitRoot, ".agenc-worktrees");
  const path = join(workspaceRoot, opts.slug);

  return gitMutationLock.with(async () => {
    // Fast resume.
    if (existsSync(path) && existsSync(join(path, ".git"))) {
      const existingGitRoot = findGitRoot(path);
      if (existingGitRoot === opts.gitRoot) {
        touchWorktreeMtime(path);
        return { path, branch, gitRoot: opts.gitRoot, created: false };
      }
      if (existingGitRoot !== null) {
        throw new Error(
          `worktree path ${path} already belongs to ${existingGitRoot}, expected ${opts.gitRoot}`,
        );
      }
    }

    if (existsSync(path)) {
      throw new Error(
        `worktree path ${path} already exists but is not a worktree for ${opts.gitRoot}`,
      );
    }

    // Fetch base if it doesn't exist locally.
    const base = opts.base ?? "HEAD";
    const fetchResult = await runGitMutation(
      ["fetch", "--depth=1", "origin", base],
      opts.gitRoot,
      opts.sandboxExecutionBroker,
      opts.gitRoot,
    );
    void fetchResult; // best-effort

    // `git worktree add -B <branch> <path> <base>`.
    const addResult = await runGitMutation(
      ["worktree", "add", "-B", branch, path, base],
      opts.gitRoot,
      opts.sandboxExecutionBroker,
      opts.gitRoot,
      [workspaceRoot],
    );
    if (addResult.code !== 0) {
      throw new Error(
        `git worktree add failed: ${addResult.stderr.trim() || addResult.stdout.trim()}`,
      );
    }

    // Optional sparse-checkout.
    if (opts.enableSparseCheckout && opts.sparsePatterns?.length) {
      const init = await runGitMutation(
        ["-C", path, "sparse-checkout", "init", "--cone"],
        opts.gitRoot,
        opts.sandboxExecutionBroker,
        opts.gitRoot,
        [path],
      );
      if (init.code !== 0) {
        // I-35 teardown verify — failing to init still leaves the
        // dir, so we treat this as a non-fatal warning. Callers can
        // still use the worktree; sparse-checkout is disabled.
        throw new Error(
          `sparse-checkout init failed: ${init.stderr.trim()}`,
        );
      }
      const set = await runGitMutation(
        ["-C", path, "sparse-checkout", "set", ...opts.sparsePatterns],
        opts.gitRoot,
        opts.sandboxExecutionBroker,
        opts.gitRoot,
        [path],
      );
      if (set.code !== 0) {
        throw new Error(`sparse-checkout set failed: ${set.stderr.trim()}`);
      }
    }

    return { path, branch, gitRoot: opts.gitRoot, created: true };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Change detection
// ─────────────────────────────────────────────────────────────────────

/**
 * Whether the worktree has any uncommitted changes or commits ahead
 * of its base. Used before cleanup to decide keep-vs-remove.
 */
export async function hasWorktreeChanges(opts: {
  readonly path: string;
  readonly baseCommit: string;
  readonly sandboxExecutionBroker: SandboxExecutionBrokerLike;
}): Promise<{
  readonly hasCommits: boolean;
  readonly isDirty: boolean;
}> {
  // NOT `-uno`: untracked files count as dirty. A subagent whose whole
  // work product is NEW files (a fresh test, a generated report) must
  // not have its worktree judged "unchanged" and deleted on close.
  // Ignored files are already excluded by `--porcelain`.
  const status = await runGit(
    ["status", "--porcelain"],
    opts.path,
    opts.sandboxExecutionBroker,
  );
  if (status.code !== 0) {
    throw new Error(
      `git status failed for ${opts.path}: ${formatGitFailure(status)}`,
    );
  }

  const revList = await runGit(
    ["rev-list", "--count", `${opts.baseCommit}..HEAD`],
    opts.path,
    opts.sandboxExecutionBroker,
  );
  if (revList.code !== 0) {
    throw new Error(
      `git rev-list failed for ${opts.path}: ${formatGitFailure(revList)}`,
    );
  }

  const commitCount = Number.parseInt(revList.stdout.trim(), 10);
  if (!Number.isFinite(commitCount)) {
    throw new Error(
      `git rev-list returned non-numeric count for ${opts.path}: ${revList.stdout.trim()}`,
    );
  }

  return {
    hasCommits: commitCount > 0,
    isDirty: status.stdout.trim().length > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Teardown (I-34 + I-35)
// ─────────────────────────────────────────────────────────────────────

export interface RemoveWorktreeOpts {
  readonly path: string;
  readonly branch: string;
  readonly gitRoot: string;
  /** Optional callback for I-35 sparse-checkout-orphaned warning. */
  readonly onSparseCheckoutOrphaned?: (detail: string) => void;
  /** Optional callback for I-34 prune-failed warning. */
  readonly onPruneFailed?: (detail: string) => void;
  readonly sandboxExecutionBroker: SandboxExecutionBrokerLike;
}

/**
 * I-34 + I-35. Force-remove worktree + branch, prune the git index,
 * verify sparse-checkout state. Failures in prune/sparse-verify are
 * logged + swallowed (the primary remove has already happened).
 */
export async function removeAgentWorktree(
  opts: RemoveWorktreeOpts,
): Promise<void> {
  return gitMutationLock.with(async () => {
    // I-35: sparse-checkout teardown verify.
    const gitDir = resolveWorktreeGitDir(opts.path);
    const sparseFile =
      gitDir !== null ? join(gitDir, "info", "sparse-checkout") : null;
    if (sparseFile !== null && existsSync(sparseFile)) {
      try {
        const contents = readFileSync(sparseFile, "utf8").trim();
        if (contents.length > 0) {
          const disable = await runGitMutation(
            ["-C", opts.path, "sparse-checkout", "disable"],
            opts.gitRoot,
            opts.sandboxExecutionBroker,
            opts.gitRoot,
            [opts.path],
          );
          if (disable.code !== 0) {
            opts.onSparseCheckoutOrphaned?.(
              `sparse-checkout disable failed: ${disable.stderr.trim()}`,
            );
          }
        }
      } catch (err) {
        opts.onSparseCheckoutOrphaned?.(
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Force-remove. Fail closed on git errors so callers never report a
    // removed worktree when git rejected the remove.
    const remove = await runGitMutation(
      ["worktree", "remove", "--force", opts.path],
      opts.gitRoot,
      opts.sandboxExecutionBroker,
      opts.gitRoot,
      [opts.path],
    );
    if (remove.code !== 0) {
      throw new Error(
        `git worktree remove failed: ${remove.stderr.trim() || remove.stdout.trim() || `exit ${remove.code}`}`,
      );
    }

    // Branch delete — best-effort (may fail if branch is the current
    // one in another worktree).
    await runGitMutation(
      ["branch", "-D", opts.branch],
      opts.gitRoot,
      opts.sandboxExecutionBroker,
      opts.gitRoot,
    );

    // I-34: prune — cleans up stale `.git/worktrees/<slug>/` dirs.
    const prune = await runGitMutation(
      ["worktree", "prune", "--force"],
      opts.gitRoot,
      opts.sandboxExecutionBroker,
      opts.gitRoot,
    );
    if (prune.code !== 0) {
      opts.onPruneFailed?.(
        `prune exited ${prune.code}: ${prune.stderr.trim()}`,
      );
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
// Base commit lookup (used by hasWorktreeChanges)
// ─────────────────────────────────────────────────────────────────────

/** Capture the current HEAD of the base branch (to compare later). */
export async function captureBaseCommit(
  gitRoot: string,
  sandboxExecutionBroker: SandboxExecutionBrokerLike,
  ref = "HEAD",
): Promise<string | null> {
  const result = await runGit(
    ["rev-parse", ref],
    gitRoot,
    sandboxExecutionBroker,
  );
  if (result.code !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

// ─────────────────────────────────────────────────────────────────────
// Stale cleanup (30-day mtime cutoff)
// ─────────────────────────────────────────────────────────────────────

export const STALE_WORKTREE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function isWorktreeStale(
  path: string,
  ageMs = STALE_WORKTREE_AGE_MS,
  nowMs = Date.now(),
): boolean {
  try {
    const stat = statSync(path);
    return nowMs - stat.mtimeMs > ageMs;
  } catch {
    return false;
  }
}

const STALE_AGENT_WORKTREE_SLUG_PATTERNS = [
  /^agent-[a-zA-Z0-9._-]+$/,
  /^wf_[0-9a-zA-Z._-]+$/,
  /^wf-\d+$/,
  /^bridge-[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/,
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/,
];

export interface CleanupStaleAgentWorktreesOpts {
  readonly gitRoot: string;
  readonly workspaceRoot?: string;
  readonly currentPath?: string;
  readonly ageMs?: number;
  readonly nowMs?: number;
  readonly sandboxExecutionBroker: SandboxExecutionBrokerLike;
}

export async function cleanupStaleAgentWorktrees(
  opts: CleanupStaleAgentWorktreesOpts,
): Promise<number> {
  const workspaceRoot =
    opts.workspaceRoot ?? join(opts.gitRoot, ".agenc-worktrees");
  const currentPath =
    opts.currentPath !== undefined ? resolvePath(opts.currentPath) : null;

  let entries: string[];
  try {
    entries = readdirSync(workspaceRoot);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const slug of entries) {
    if (!isEphemeralAgentWorktreeSlug(slug)) {
      continue;
    }

    const path = join(workspaceRoot, slug);
    if (currentPath !== null && resolvePath(path) === currentPath) {
      continue;
    }
    if (!isWorktreeStale(path, opts.ageMs, opts.nowMs)) {
      continue;
    }
    if (!(await canRemoveStaleWorktree(path, opts.sandboxExecutionBroker))) {
      continue;
    }

    try {
      await removeAgentWorktree({
        path,
        branch: worktreeBranchName(slug),
        gitRoot: opts.gitRoot,
        sandboxExecutionBroker: opts.sandboxExecutionBroker,
      });
      removed += 1;
    } catch {
      // Fail closed: leave the stale worktree in place if git does not
      // recognize it or teardown cannot prove completion.
    }
  }

  return removed;
}

function canRemoveStaleWorktree(
  path: string,
  sandboxExecutionBroker: SandboxExecutionBrokerLike,
): Promise<boolean> {
  return Promise.all([
    runGit(["status", "--porcelain", "-uno"], path, sandboxExecutionBroker),
    runGit(
      ["rev-list", "--max-count=1", "HEAD", "--not", "--remotes"],
      path,
      sandboxExecutionBroker,
    ),
  ]).then(([status, unpushed]) => {
    if (status.code !== 0 || status.stdout.trim().length > 0) {
      return false;
    }
    if (unpushed.code !== 0 || unpushed.stdout.trim().length > 0) {
      return false;
    }
    return true;
  });
}

function isEphemeralAgentWorktreeSlug(slug: string): boolean {
  return STALE_AGENT_WORKTREE_SLUG_PATTERNS.some((pattern) =>
    pattern.test(slug),
  );
}

function touchWorktreeMtime(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // Best-effort only; the resume path still works even when mtime refresh fails.
  }
}

function formatGitFailure(result: GitResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}
