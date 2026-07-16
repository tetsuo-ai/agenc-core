import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STALE_WORKTREE_AGE_MS,
  cleanupStaleAgentWorktrees as cleanupStaleAgentWorktreesUnbound,
  findGitRoot,
  getOrCreateWorktree as getOrCreateWorktreeUnbound,
  hasWorktreeChanges as hasWorktreeChangesUnbound,
  isWorktreeStale,
  removeAgentWorktree as removeAgentWorktreeUnbound,
  validateWorktreeSlug,
} from "./worktree.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

const getOrCreateWorktree = (
  opts: Omit<
    Parameters<typeof getOrCreateWorktreeUnbound>[0],
    "sandboxExecutionBroker"
  >,
) => getOrCreateWorktreeUnbound({
  ...opts,
  sandboxExecutionBroker: explicitDangerBroker,
});

const removeAgentWorktree = (
  opts: Omit<
    Parameters<typeof removeAgentWorktreeUnbound>[0],
    "sandboxExecutionBroker"
  >,
) => removeAgentWorktreeUnbound({
  ...opts,
  sandboxExecutionBroker: explicitDangerBroker,
});

const hasWorktreeChanges = (
  opts: Omit<
    Parameters<typeof hasWorktreeChangesUnbound>[0],
    "sandboxExecutionBroker"
  >,
) => hasWorktreeChangesUnbound({
  ...opts,
  sandboxExecutionBroker: explicitDangerBroker,
});

const cleanupStaleAgentWorktrees = (
  opts: Omit<
    Parameters<typeof cleanupStaleAgentWorktreesUnbound>[0],
    "sandboxExecutionBroker"
  >,
) => cleanupStaleAgentWorktreesUnbound({
  ...opts,
  sandboxExecutionBroker: explicitDangerBroker,
});

function createLinkedWorktree(
  canonicalRoot: string,
  worktreeRoot: string,
  slug: string,
): void {
  const commonGitDir = join(canonicalRoot, ".git");
  const worktreeGitDir = join(commonGitDir, "worktrees", slug);
  mkdirSync(commonGitDir, { recursive: true });
  mkdirSync(worktreeGitDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`);
  writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
  writeFileSync(join(worktreeGitDir, "gitdir"), join(worktreeRoot, ".git"));
}

function initRepo(repo: string, remote?: string): void {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "tests@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "Tests"], { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "root\n");
  writeFileSync(join(repo, "src", "index.ts"), "export const ok = true;\n");
  execFileSync("git", ["add", "README.md", "src/index.ts"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

  if (!remote) {
    return;
  }

  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
  execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd: repo });
}

function worktreeGitDir(worktreePath: string): string {
  const gitFile = readFileSync(join(worktreePath, ".git"), "utf8").trim();
  if (!gitFile.startsWith("gitdir:")) {
    throw new Error(`expected linked-worktree .git file, got: ${gitFile}`);
  }
  return resolvePath(worktreePath, gitFile.slice("gitdir:".length).trim());
}

describe("validateWorktreeSlug", () => {
  it("accepts alphanumeric + dot/underscore/dash", () => {
    expect(() => validateWorktreeSlug("my-feature_1.2")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateWorktreeSlug("")).toThrow(/1-64 chars/);
  });

  it("rejects over 64 chars", () => {
    expect(() => validateWorktreeSlug("a".repeat(65))).toThrow(/1-64 chars/);
  });

  it("rejects path separators", () => {
    expect(() => validateWorktreeSlug("a/b")).toThrow();
    expect(() => validateWorktreeSlug("../etc")).toThrow();
  });

  it("rejects shell-metacharacters", () => {
    expect(() => validateWorktreeSlug("a b")).toThrow();
    expect(() => validateWorktreeSlug("a|b")).toThrow();
  });
});

describe("findGitRoot", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "agenc-worktree-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("resolves linked worktrees back to the canonical repo root", () => {
    const canonicalRoot = join(tmpRoot, "repo");
    const worktreeRoot = join(tmpRoot, "repo-wt");
    const nested = join(worktreeRoot, "a", "b", "c");
    createLinkedWorktree(canonicalRoot, worktreeRoot, "feature-a");
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBe(canonicalRoot);
  });

  it("falls back to the local root when .git is just a plain gitdir file", () => {
    writeFileSync(join(tmpRoot, ".git"), "gitdir: /elsewhere/.git/worktrees/x");
    expect(findGitRoot(tmpRoot)).toBe(tmpRoot);
  });

  it("returns null when no .git ancestor", () => {
    expect(findGitRoot(tmpRoot)).toBeNull();
  });
});

describe("getOrCreateWorktree", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "agenc-worktree-create-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("rejects a pre-existing worktree path that belongs to another canonical repo", async () => {
    const canonicalRoot = join(tmpRoot, "repo-a");
    const foreignRoot = join(tmpRoot, "repo-b");
    const workspaceRoot = join(tmpRoot, "workspace");
    const foreignWorktreeRoot = join(workspaceRoot, "feat");
    mkdirSync(join(canonicalRoot, ".git"), { recursive: true });
    createLinkedWorktree(foreignRoot, foreignWorktreeRoot, "foreign-feat");

    await expect(
      getOrCreateWorktree({
        gitRoot: canonicalRoot,
        slug: "feat",
        workspaceRoot,
      }),
    ).rejects.toThrow(/already belongs to/);
  });

  it("refreshes mtime when resuming an existing worktree", async () => {
    const repo = join(tmpRoot, "repo");
    initRepo(repo);

    const first = await getOrCreateWorktree({
      gitRoot: repo,
      slug: "agent-resume",
    });
    const old = (Date.now() - STALE_WORKTREE_AGE_MS - 1000) / 1000;
    utimesSync(first.path, old, old);
    expect(isWorktreeStale(first.path)).toBe(true);

    const resumed = await getOrCreateWorktree({
      gitRoot: repo,
      slug: "agent-resume",
    });

    expect(resumed.created).toBe(false);
    expect(isWorktreeStale(first.path)).toBe(false);
  });

  it("separates metadata registration from restricted checkout", async () => {
    const repo = join(tmpRoot, "repo");
    initRepo(repo);
    const broker = explicitDangerBroker.forkForCwd(repo);
    const prepareSpawn = vi.spyOn(broker, "prepareSpawn");

    const handle = await getOrCreateWorktreeUnbound({
      gitRoot: repo,
      slug: "two-phase",
      sandboxExecutionBroker: broker,
    });

    const commands = prepareSpawn.mock.calls.map(([, command]) => command);
    const add = commands.find((command) =>
      command.args.includes("worktree") && command.args.includes("add")
    );
    const checkout = commands.find((command) =>
      command.args.includes("checkout") && command.args.includes("HEAD")
    );
    expect(add?.args).toContain("--no-checkout");
    expect(checkout).toBeDefined();
    const checkoutPaths = checkout?.additionalPermissions?.fileSystem?.entries
      .map((entry) => entry.path.kind === "path" ? entry.path.path : "");
    expect(checkoutPaths).toContain(handle.path);
    expect(checkoutPaths).not.toContain(join(repo, ".git"));
  });
});

describe("removeAgentWorktree", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "agenc-worktree-remove-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("fails closed when git rejects the worktree remove", async () => {
    const repo = join(tmpRoot, "repo");
    initRepo(repo);

    await expect(
      removeAgentWorktree({
        path: join(repo, ".agenc-worktrees", "missing"),
        branch: "worktree-missing",
        gitRoot: repo,
      }),
    ).rejects.toThrow(/git worktree remove failed/i);
  });

  it("checks linked-worktree sparse state before failing a remove", async () => {
    const repo = join(tmpRoot, "repo");
    const wrongRepo = join(tmpRoot, "wrong-repo");
    initRepo(repo);
    initRepo(wrongRepo);

    const handle = await getOrCreateWorktree({
      gitRoot: repo,
      slug: "agent-sparse",
    });
    execFileSync("git", ["-C", handle.path, "sparse-checkout", "init", "--cone"]);
    execFileSync("git", ["-C", handle.path, "sparse-checkout", "set", "src"]);

    const sparseFile = join(
      worktreeGitDir(handle.path),
      "info",
      "sparse-checkout",
    );
    expect(existsSync(sparseFile)).toBe(true);

    await expect(
      removeAgentWorktree({
        path: handle.path,
        branch: handle.branch,
        gitRoot: wrongRepo,
      }),
    ).rejects.toThrow(/git worktree remove failed/i);

    const sparseConfig = spawnSync(
      "git",
      ["-C", handle.path, "config", "--worktree", "--get", "core.sparseCheckout"],
      { encoding: "utf8" },
    );
    expect(sparseConfig.stdout.trim()).not.toBe("true");
  });
});

describe("hasWorktreeChanges", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "agenc-worktree-probe-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("throws when git cannot verify the baseline commit", async () => {
    const repo = join(tmpRoot, "repo");
    initRepo(repo);
    const handle = await getOrCreateWorktree({
      gitRoot: repo,
      slug: "agent-probe",
    });

    await expect(
      hasWorktreeChanges({
        path: handle.path,
        baseCommit: "not-a-commit",
      }),
    ).rejects.toThrow(/git rev-list failed/i);
  });
});

describe("cleanupStaleAgentWorktrees", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "agenc-worktree-cleanup-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("removes stale clean agent worktrees whose HEAD is already on a remote", async () => {
    const repo = join(tmpRoot, "repo");
    const remote = join(tmpRoot, "remote.git");
    initRepo(repo, remote);

    const handle = await getOrCreateWorktree({
      gitRoot: repo,
      slug: "agent-cleanup",
    });
    const old = (Date.now() - STALE_WORKTREE_AGE_MS - 1000) / 1000;
    utimesSync(handle.path, old, old);

    await expect(
      cleanupStaleAgentWorktrees({ gitRoot: repo }),
    ).resolves.toBe(1);
    expect(existsSync(handle.path)).toBe(false);
  });

  it("skips stale non-ephemeral worktrees", async () => {
    const repo = join(tmpRoot, "repo");
    const remote = join(tmpRoot, "remote.git");
    initRepo(repo, remote);

    const handle = await getOrCreateWorktree({
      gitRoot: repo,
      slug: "feature-keep",
    });
    const old = (Date.now() - STALE_WORKTREE_AGE_MS - 1000) / 1000;
    utimesSync(handle.path, old, old);

    await expect(
      cleanupStaleAgentWorktrees({ gitRoot: repo }),
    ).resolves.toBe(0);
    expect(existsSync(handle.path)).toBe(true);
  });
});

describe("isWorktreeStale", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agenc-worktree-stale-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false for fresh directories", () => {
    expect(isWorktreeStale(tmp)).toBe(false);
  });

  it("returns true for mtime older than STALE_WORKTREE_AGE_MS", () => {
    const old = (Date.now() - STALE_WORKTREE_AGE_MS - 1000) / 1000;
    utimesSync(tmp, old, old);
    expect(isWorktreeStale(tmp)).toBe(true);
  });

  it("returns false for nonexistent path", () => {
    expect(isWorktreeStale(join(tmp, "missing"))).toBe(false);
  });
});
