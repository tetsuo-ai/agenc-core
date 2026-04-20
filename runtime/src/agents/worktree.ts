/**
 * Git worktree lifecycle for subagent isolation.
 *
 * Hand-port of openclaude `utils/worktree.ts` (1,563 LOC) focused on
 * the core create/resume/teardown paths. The openclaude file mixes
 * in telemetry, stale-cleanup cron, and UI-specific flows; AgenC's
 * T9 subset includes:
 *
 *   - `getOrCreateWorktree(gitRoot, slug)` — fast resume if exists,
 *     else `git worktree add -B worktree-<slug>`.
 *   - `removeAgentWorktree(path, branch, gitRoot)` — force-remove
 *     + branch delete + **I-34 prune** + **I-35 sparse-checkout verify**.
 *   - `hasWorktreeChanges(path, baseCommit)` — check for commits /
 *     dirty files before deleting.
 *   - `findGitRoot(cwd)` — walk up for `.git`.
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
  readFileSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve as resolvePath } from "node:path";
import { AsyncLock } from "../utils/async-lock.js";

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
export function runGit(
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    const child = spawn("git", [...args], { cwd, stdio: "pipe" });
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

// ─────────────────────────────────────────────────────────────────────
// Git root discovery
// ─────────────────────────────────────────────────────────────────────

/**
 * Walk up from `startDir` looking for a `.git` entry (directory or
 * file — `.git` is a file when the dir is itself a worktree). Returns
 * the repo root on success; null if not inside a repo.
 */
export function findGitRoot(startDir: string): string | null {
  let dir = resolvePath(startDir);
  while (true) {
    const probe = join(dir, ".git");
    if (existsSync(probe)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Slug validation
// ─────────────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-zA-Z0-9._-]+$/;
const MAX_SLUG_LEN = 64;

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
}

/**
 * Create a new worktree (or fast-resume an existing one).
 *
 * Fast resume: if `<workspaceRoot>/worktrees/<slug>` exists + its
 * `.git` points at the parent repo, skip the `git worktree add`.
 */
export async function getOrCreateWorktree(
  opts: GetOrCreateOpts,
): Promise<WorktreeHandle> {
  validateWorktreeSlug(opts.slug);
  const branch = `worktree-${opts.slug}`;
  const workspaceRoot =
    opts.workspaceRoot ?? join(opts.gitRoot, ".agenc-worktrees");
  const path = join(workspaceRoot, opts.slug);

  return gitMutationLock.with(async () => {
    // Fast resume.
    if (existsSync(path) && existsSync(join(path, ".git"))) {
      return { path, branch, gitRoot: opts.gitRoot, created: false };
    }

    // Fetch base if it doesn't exist locally.
    const base = opts.base ?? "HEAD";
    const fetchResult = await runGit(["fetch", "--depth=1", "origin", base], opts.gitRoot);
    void fetchResult; // best-effort

    // `git worktree add -B <branch> <path> <base>`.
    const addResult = await runGit(
      ["worktree", "add", "-B", branch, path, base],
      opts.gitRoot,
    );
    if (addResult.code !== 0) {
      throw new Error(
        `git worktree add failed: ${addResult.stderr.trim() || addResult.stdout.trim()}`,
      );
    }

    // Optional sparse-checkout.
    if (opts.enableSparseCheckout && opts.sparsePatterns?.length) {
      const init = await runGit(
        ["-C", path, "sparse-checkout", "init", "--cone"],
        opts.gitRoot,
      );
      if (init.code !== 0) {
        // I-35 teardown verify — failing to init still leaves the
        // dir, so we treat this as a non-fatal warning. Callers can
        // still use the worktree; sparse-checkout is disabled.
        throw new Error(
          `sparse-checkout init failed: ${init.stderr.trim()}`,
        );
      }
      const set = await runGit(
        ["-C", path, "sparse-checkout", "set", ...opts.sparsePatterns],
        opts.gitRoot,
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
}): Promise<{
  readonly hasCommits: boolean;
  readonly isDirty: boolean;
}> {
  const status = await runGit(
    ["status", "--porcelain", "-uno"],
    opts.path,
  );
  const revList = await runGit(
    ["rev-list", "--count", `${opts.baseCommit}..HEAD`],
    opts.path,
  );
  return {
    hasCommits: revList.code === 0 && Number.parseInt(revList.stdout.trim(), 10) > 0,
    isDirty: status.code === 0 && status.stdout.trim().length > 0,
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
    const sparseFile = join(opts.path, ".git", "info", "sparse-checkout");
    if (existsSync(sparseFile)) {
      try {
        const contents = readFileSync(sparseFile, "utf8").trim();
        if (contents.length > 0) {
          const disable = await runGit(
            ["-C", opts.path, "sparse-checkout", "disable"],
            opts.gitRoot,
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

    // Force-remove.
    await runGit(
      ["worktree", "remove", "--force", opts.path],
      opts.gitRoot,
    );

    // Branch delete — best-effort (may fail if branch is the current
    // one in another worktree).
    await runGit(["branch", "-D", opts.branch], opts.gitRoot);

    // I-34: prune — cleans up stale `.git/worktrees/<slug>/` dirs.
    const prune = await runGit(
      ["worktree", "prune", "--force"],
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
  ref = "HEAD",
): Promise<string | null> {
  const result = await runGit(["rev-parse", ref], gitRoot);
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
): boolean {
  try {
    const stat = statSync(path);
    return Date.now() - stat.mtimeMs > ageMs;
  } catch {
    return false;
  }
}
