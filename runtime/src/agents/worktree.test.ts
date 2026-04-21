import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STALE_WORKTREE_AGE_MS,
  findGitRoot,
  getOrCreateWorktree,
  isWorktreeStale,
  removeAgentWorktree,
  validateWorktreeSlug,
} from "./worktree.js";

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
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Tests"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "root\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

    await expect(
      removeAgentWorktree({
        path: join(repo, ".agenc-worktrees", "missing"),
        branch: "worktree-missing",
        gitRoot: repo,
      }),
    ).rejects.toThrow(/git worktree remove failed/i);
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
