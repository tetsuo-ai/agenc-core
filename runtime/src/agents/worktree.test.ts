import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STALE_WORKTREE_AGE_MS,
  findGitRoot,
  isWorktreeStale,
  validateWorktreeSlug,
} from "./worktree.js";

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

  it("finds the git root by ancestor walk", () => {
    mkdirSync(join(tmpRoot, ".git"));
    const nested = join(tmpRoot, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBe(tmpRoot);
  });

  it("handles .git as a file (submodule/worktree)", () => {
    writeFileSync(join(tmpRoot, ".git"), "gitdir: /elsewhere/.git/worktrees/x");
    expect(findGitRoot(tmpRoot)).toBe(tmpRoot);
  });

  it("returns null when no .git ancestor", () => {
    expect(findGitRoot(tmpRoot)).toBeNull();
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
