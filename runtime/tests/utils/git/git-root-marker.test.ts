import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  isBareGitDirectory,
  isValidGitMarker,
} from "../../../src/utils/git/gitRootMarker.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "agenc-git-root-marker-"));
  roots.push(root);
  return root;
}

function writeGitDirectory(dir: string): void {
  mkdirSync(join(dir, "objects"), { recursive: true });
  mkdirSync(join(dir, "refs"), { recursive: true });
  writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
}

describe("git root marker identity", () => {
  test("accepts a git directory or a gitdir pointer to one", () => {
    const root = tempDir();
    const gitDir = join(root, "repo", ".git");
    writeGitDirectory(gitDir);
    expect(isValidGitMarker(gitDir)).toBe(true);

    const linked = join(root, "linked", ".git");
    mkdirSync(join(root, "linked"), { recursive: true });
    writeFileSync(linked, `gitdir: ${gitDir}\n`);
    expect(isValidGitMarker(linked)).toBe(true);
  });

  test("accepts a gitdir pointer to a linked-worktree private dir", () => {
    const root = tempDir();
    const privateDir = join(root, "main", ".git", "worktrees", "linked");
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(join(privateDir, "commondir"), "../..\n");
    writeFileSync(join(privateDir, "gitdir"), `${join(root, "linked", ".git")}\n`);
    const pointer = join(root, "linked", ".git");
    mkdirSync(join(root, "linked"), { recursive: true });
    writeFileSync(pointer, `gitdir: ${privateDir}\n`);
    expect(isValidGitMarker(pointer)).toBe(true);
  });

  test("rejects empty, malformed, and dangling .git entries", () => {
    const root = tempDir();
    const emptyDir = join(root, "empty", ".git");
    mkdirSync(emptyDir, { recursive: true });
    expect(isValidGitMarker(emptyDir)).toBe(false);

    const incomplete = join(root, "incomplete", ".git");
    mkdirSync(join(incomplete, "objects"), { recursive: true });
    writeFileSync(join(incomplete, "HEAD"), "ref: refs/heads/main\n");
    expect(isValidGitMarker(incomplete)).toBe(false);

    const missingPrefix = join(root, "plain-file");
    writeFileSync(missingPrefix, "not a gitdir pointer\n");
    expect(isValidGitMarker(missingPrefix)).toBe(false);

    const emptyPointer = join(root, "empty-pointer");
    writeFileSync(emptyPointer, "gitdir:\n");
    expect(isValidGitMarker(emptyPointer)).toBe(false);

    const whitespacePointer = join(root, "whitespace-pointer");
    writeFileSync(whitespacePointer, "gitdir:   \n");
    expect(isValidGitMarker(whitespacePointer)).toBe(false);

    const dangling = join(root, "dangling");
    writeFileSync(dangling, `gitdir: ${join(root, "missing.git")}\n`);
    expect(isValidGitMarker(dangling)).toBe(false);

    expect(isValidGitMarker(join(root, "absent"))).toBe(false);
  });

  test("a checkout .git is a marker but never a bare repository", () => {
    const root = tempDir();
    const checkoutGit = join(root, "repo", ".git");
    writeGitDirectory(checkoutGit);
    expect(isValidGitMarker(checkoutGit)).toBe(true);
    expect(isBareGitDirectory(checkoutGit)).toBe(false);

    const bare = join(root, "upstream.git");
    writeGitDirectory(bare);
    expect(isBareGitDirectory(bare)).toBe(true);
    expect(isBareGitDirectory(join(root, "missing.git"))).toBe(false);
  });
});
