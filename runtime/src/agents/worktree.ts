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
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { AsyncLock } from "./_deps/async-lock.js";
import type { SandboxExecutionBrokerLike } from "../sandbox/execution-broker.js";
import { gitChildEnvironment } from "../sandbox/git-environment.js";
import { runSupervisedProcess } from "../utils/supervisedProcess.js";
import type { AdditionalPermissionProfile } from "../sandbox/engine/index.js";
import {
  hardenGitWorktreeMutationArgs,
  worktreeCheckoutPermissions,
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

/**
 * Run `git <args>` under `cwd`. Does NOT throw; returns a result.
 *
 * Exported for the M5 worktree-lifecycle library so every workflow git
 * invocation shares this hardened path (broker spawn, scrubbed child env,
 * argument hardening, bounded output) instead of growing a second one.
 */
export function runGit(
  args: ReadonlyArray<string>,
  cwd: string,
  sandboxExecutionBroker: SandboxExecutionBrokerLike,
  additionalPermissions?: AdditionalPermissionProfile,
): Promise<GitResult> {
  const command = sandboxExecutionBroker.prepareSpawn("child_agent", {
      program: "git",
      args: hardenGitWorktreeMutationArgs(args),
      cwd,
      env: gitChildEnvironment(),
      argv0: "git",
      ...(additionalPermissions !== undefined
        ? { additionalPermissions }
        : {}),
      trustedExecutable: true,
  });
  return runSupervisedProcess(command, {
    timeoutMs: 30_000,
    maxOutputBytes: 4 * 1024 * 1024,
  }).then((result) => ({
    code: result.stopReason === "spawn_error"
      ? 127
      : result.stopReason === "timeout"
        ? 124
        : result.stopReason !== undefined
          ? 1
          : (result.exitCode ?? 1),
    stdout: result.stdout.toString("utf8"),
    stderr: result.error?.message ?? result.stderr.toString("utf8"),
  }));
}

export function runGitMutation(
  args: ReadonlyArray<string>,
  cwd: string,
  sandboxExecutionBroker: SandboxExecutionBrokerLike,
  repoRoot: string,
  writablePaths: readonly string[] = [],
): Promise<GitResult> {
  return runGit(
    args,
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

/**
 * Stable, repository-global worktree identity for one logical agent spawn.
 *
 * Agent task names are unique only among siblings. Worktree directories and
 * branches live in the repository-global namespace, so include the durable
 * session identity, full agent path, and per-spawn epoch in a
 * collision-resistant suffix while retaining a short human-readable path
 * segment. The epoch prevents a later spawn at the same path from silently
 * resuming retained commits or dirty state from an earlier worker.
 */
export function deriveAgentWorktreeSlug(opts: {
  readonly sessionId: string;
  readonly agentPath: string;
  readonly spawnId: string;
}): string {
  const pathName =
    opts.agentPath.split("/").filter((segment) => segment.length > 0).at(-1) ??
    "agent";
  const readable =
    pathName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^[._-]+|[._-]+$/gu, "")
      .slice(0, 31)
      .replace(/[._-]+$/gu, "") || "agent";
  const identity = JSON.stringify([
    opts.sessionId,
    opts.agentPath,
    opts.spawnId,
  ]);
  const suffix = createHash("sha256")
    .update("agenc-agent-worktree-v1\0", "utf8")
    .update(identity, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${readable}-${suffix}`;
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

    // Worktree setup is deliberately local-only. Repository-controlled remotes,
    // credential helpers, and transport helpers are not an implicit capability.
    const base = opts.base ?? "HEAD";

    // Register metadata without materializing repository content. Checkout is
    // a second, narrowly granted phase so a configured filter cannot write the
    // common .git directory with Git's inherited authority.
    const addResult = await runGitMutation(
      ["worktree", "add", "--no-checkout", "-B", branch, path, base],
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

    const checkoutPermissions = worktreeCheckoutPermissions(opts.gitRoot, path);
    const tearDownIncompleteWorktree = async (message: string): Promise<never> => {
      await runGitMutation(
        ["worktree", "remove", "--force", path],
        opts.gitRoot,
        opts.sandboxExecutionBroker,
        opts.gitRoot,
        [workspaceRoot],
      );
      throw new Error(message);
    };

    // Optional sparse-checkout.
    if (opts.enableSparseCheckout && opts.sparsePatterns?.length) {
      const init = await runGit(
        ["-C", path, "sparse-checkout", "init", "--cone"],
        opts.gitRoot,
        opts.sandboxExecutionBroker,
        checkoutPermissions,
      );
      if (init.code !== 0) {
        await tearDownIncompleteWorktree(
          `sparse-checkout init failed: ${init.stderr.trim()}`,
        );
      }
      const set = await runGit(
        ["-C", path, "sparse-checkout", "set", ...opts.sparsePatterns],
        opts.gitRoot,
        opts.sandboxExecutionBroker,
        checkoutPermissions,
      );
      if (set.code !== 0) {
        await tearDownIncompleteWorktree(
          `sparse-checkout set failed: ${set.stderr.trim()}`,
        );
      }
    }

    const checkout = await runGit(
      ["-C", path, "checkout", "HEAD"],
      opts.gitRoot,
      opts.sandboxExecutionBroker,
      checkoutPermissions,
    );
    if (checkout.code !== 0) {
      await tearDownIncompleteWorktree(
        `git worktree checkout failed: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
      );
    }

    return { path, branch, gitRoot: opts.gitRoot, created: true };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Change detection
// ─────────────────────────────────────────────────────────────────────

/**
 * Human-facing coordinates for finding the retained worktree.
 *
 * These values are locators only. In particular, `branch` is mutable and must
 * never be treated as an integration ref. A successful
 * `committed_clean` capture carries the only integration-safe ref.
 */
export interface WorktreeTurnEvidenceLocator {
  readonly path: string;
  readonly branch: string;
  readonly gitRoot: string;
}

interface VerifiableWorktreeTurnEvidence {
  readonly locator: WorktreeTurnEvidenceLocator;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly treeHash: string;
  readonly clean: boolean;
  readonly baseIsAncestor: boolean;
}

type NonIntegrableWorktreeTurnEvidence = {
  readonly integrationRef?: never;
};

/**
 * Immutable, read-only evidence captured from a worktree after one agent turn.
 *
 * Only a clean HEAD that changed and remains a descendant of the captured base
 * is safe to offer for integration. Every other state deliberately omits
 * `integrationRef`; callers must not infer one from the mutable branch/path
 * locator.
 */
export type WorktreeTurnEvidence =
  | (VerifiableWorktreeTurnEvidence & {
      readonly state: "committed_clean";
      readonly clean: true;
      readonly baseIsAncestor: true;
      /** Exact immutable commit, never the mutable worktree branch. */
      readonly integrationRef: string;
    })
  | (VerifiableWorktreeTurnEvidence &
      NonIntegrableWorktreeTurnEvidence & {
        readonly state: "unchanged_clean";
        readonly clean: true;
        readonly baseIsAncestor: true;
      })
  | (VerifiableWorktreeTurnEvidence &
      NonIntegrableWorktreeTurnEvidence & {
        readonly state: "dirty_uncommitted";
        readonly clean: false;
        readonly baseIsAncestor: true;
      })
  | (VerifiableWorktreeTurnEvidence &
      NonIntegrableWorktreeTurnEvidence & {
        readonly state: "diverged";
        readonly baseIsAncestor: false;
      })
  | (NonIntegrableWorktreeTurnEvidence & {
      readonly state: "unverifiable";
      readonly locator: WorktreeTurnEvidenceLocator;
      readonly error: string;
    });

export interface CaptureWorktreeTurnEvidenceOpts {
  readonly locator: WorktreeTurnEvidenceLocator;
  readonly baseCommit: string;
  readonly sandboxExecutionBroker: SandboxExecutionBrokerLike;
}

const FULL_GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const EVIDENCE_GIT_OPTIONS = [
  "--no-replace-objects",
  "--no-optional-locks",
] as const;

function evidenceGitArgs(args: readonly string[]): string[] {
  return [...EVIDENCE_GIT_OPTIONS, ...args];
}

/**
 * Capture fail-closed worktree evidence without mutating the index, worktree,
 * branch, or object database.
 */
export async function captureWorktreeTurnEvidence(
  opts: CaptureWorktreeTurnEvidenceOpts,
): Promise<WorktreeTurnEvidence> {
  const locator: WorktreeTurnEvidenceLocator = {
    path: opts.locator.path,
    branch: opts.locator.branch,
    gitRoot: opts.locator.gitRoot,
  };
  const unverifiable = (error: string): WorktreeTurnEvidence => ({
    state: "unverifiable",
    locator,
    error: sanitizeEvidenceError(error),
  });

  if (!FULL_GIT_OBJECT_ID_RE.test(opts.baseCommit)) {
    return unverifiable("base commit is not a full Git object id");
  }
  const canonicalGitRoot = findGitRoot(locator.path);
  if (
    canonicalGitRoot === null ||
    resolvePath(canonicalGitRoot) !== resolvePath(locator.gitRoot)
  ) {
    return unverifiable(
      "worktree locator does not match its canonical Git root",
    );
  }

  try {
    const headResult = await runGit(
      evidenceGitArgs(["rev-parse", "--verify", "HEAD^{commit}"]),
      locator.path,
      opts.sandboxExecutionBroker,
    );
    if (headResult.code !== 0) {
      return unverifiable(gitEvidenceFailure("HEAD lookup", headResult));
    }
    const headCommit = parseFullGitObjectId(headResult.stdout);
    if (headCommit === null) {
      return unverifiable("HEAD lookup returned an invalid Git object id");
    }

    // Resolve the tree from the immutable commit captured above, not from HEAD
    // again, so a concurrent branch move cannot pair a different tree with it.
    const treeResult = await runGit(
      evidenceGitArgs([
        "rev-parse",
        "--verify",
        `${headCommit}^{tree}`,
      ]),
      locator.path,
      opts.sandboxExecutionBroker,
    );
    if (treeResult.code !== 0) {
      return unverifiable(gitEvidenceFailure("tree lookup", treeResult));
    }
    const treeHash = parseFullGitObjectId(treeResult.stdout);
    if (treeHash === null) {
      return unverifiable("tree lookup returned an invalid Git object id");
    }

    // Untracked files are turn output too; ignored files remain excluded by
    // Git's porcelain status contract.
    const statusResult = await runGit(
      evidenceGitArgs([
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
      locator.path,
      opts.sandboxExecutionBroker,
    );
    if (statusResult.code !== 0) {
      return unverifiable(gitEvidenceFailure("worktree status", statusResult));
    }
    const clean = statusResult.stdout.length === 0;

    const ancestryResult = await runGit(
      evidenceGitArgs([
        "merge-base",
        "--is-ancestor",
        opts.baseCommit,
        headCommit,
      ]),
      locator.path,
      opts.sandboxExecutionBroker,
    );
    if (ancestryResult.code !== 0 && ancestryResult.code !== 1) {
      return unverifiable(
        gitEvidenceFailure("base ancestry check", ancestryResult),
      );
    }
    const baseIsAncestor = ancestryResult.code === 0;

    const stableHeadResult = await runGit(
      evidenceGitArgs(["rev-parse", "--verify", "HEAD^{commit}"]),
      locator.path,
      opts.sandboxExecutionBroker,
    );
    if (stableHeadResult.code !== 0) {
      return unverifiable(
        gitEvidenceFailure("HEAD stability check", stableHeadResult),
      );
    }
    const stableHeadCommit = parseFullGitObjectId(stableHeadResult.stdout);
    if (stableHeadCommit === null) {
      return unverifiable(
        "HEAD stability check returned an invalid Git object id",
      );
    }
    if (stableHeadCommit !== headCommit) {
      return unverifiable("HEAD changed while worktree evidence was captured");
    }

    const stableStatusResult = await runGit(
      evidenceGitArgs([
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
      locator.path,
      opts.sandboxExecutionBroker,
    );
    if (stableStatusResult.code !== 0) {
      return unverifiable(
        gitEvidenceFailure(
          "worktree status stability check",
          stableStatusResult,
        ),
      );
    }
    if (stableStatusResult.stdout !== statusResult.stdout) {
      return unverifiable(
        "worktree status changed while evidence was captured",
      );
    }

    const common = {
      locator,
      baseCommit: opts.baseCommit,
      headCommit,
      treeHash,
      clean,
      baseIsAncestor,
    };

    // Divergence takes precedence over dirtiness: neither state is
    // integrable, and preserving the broken ancestry is the stronger signal.
    if (!baseIsAncestor) {
      return { ...common, state: "diverged", baseIsAncestor: false };
    }
    if (!clean) {
      return {
        ...common,
        state: "dirty_uncommitted",
        clean: false,
        baseIsAncestor: true,
      };
    }
    if (headCommit === opts.baseCommit.toLowerCase()) {
      return {
        ...common,
        state: "unchanged_clean",
        clean: true,
        baseIsAncestor: true,
      };
    }
    return {
      ...common,
      state: "committed_clean",
      clean: true,
      baseIsAncestor: true,
      integrationRef: headCommit,
    };
  } catch {
    // Broker/runtime exceptions can contain machine-local paths or arbitrary
    // child diagnostics. Keep durable/model-facing evidence generic.
    return unverifiable("worktree evidence capture failed");
  }
}

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

function parseFullGitObjectId(stdout: string): string | null {
  const value = stdout.trim().toLowerCase();
  return FULL_GIT_OBJECT_ID_RE.test(value) ? value : null;
}

function gitEvidenceFailure(operation: string, result: GitResult): string {
  return `${operation} failed (git exit ${result.code})`;
}

function sanitizeEvidenceError(error: string): string {
  const sanitized = error
    // Strip terminal escapes and control characters before evidence reaches a
    // daemon event or model context.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (sanitized || "worktree evidence capture failed").slice(0, 512);
}
