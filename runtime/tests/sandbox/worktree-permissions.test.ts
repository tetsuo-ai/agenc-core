import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hardenGitWorktreeMutationArgs,
  linkedWorktreePointerPaths,
  resolveGitMetadataRoot,
  worktreeCheckoutPermissions,
  worktreeMutationPermissions,
} from "../../src/sandbox/worktree-permissions.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("worktree mutation metadata permissions", () => {
  it("disables optional maintenance before controlled Git transactions", () => {
    const args = hardenGitWorktreeMutationArgs(["commit", "-m", "snapshot"]);

    const legacyGc = args.indexOf("gc.auto=0");
    expect(args[legacyGc - 1]).toBe("-c");
    expect(legacyGc).toBeLessThan(args.indexOf("commit"));
    const maintenance = args.indexOf("maintenance.auto=false");
    expect(args[maintenance - 1]).toBe("-c");
    expect(maintenance).toBeLessThan(args.indexOf("commit"));
  });

  it("grants a bare repository common directory instead of a nonexistent nested .git", () => {
    const bareRoot = mkdtempSync(join(tmpdir(), "agenc-bare-repo-"));
    roots.push(bareRoot);
    mkdirSync(join(bareRoot, "objects"));
    mkdirSync(join(bareRoot, "refs"));
    writeFileSync(join(bareRoot, "HEAD"), "ref: refs/heads/main\n");

    expect(resolveGitMetadataRoot(bareRoot)).toBe(bareRoot);
    expect(worktreeMutationPermissions(bareRoot)).toEqual({
      fileSystem: {
        entries: [
          {
            path: { kind: "path", path: bareRoot },
            access: "write",
          },
        ],
      },
    });
  });

  it("continues to grant only .git for an ordinary working repository", () => {
    const workRoot = mkdtempSync(join(tmpdir(), "agenc-working-repo-"));
    roots.push(workRoot);
    mkdirSync(join(workRoot, ".git"));

    expect(resolveGitMetadataRoot(workRoot)).toBe(join(workRoot, ".git"));
  });

  it("materialization grants only linked admin metadata, never common .git", () => {
    const workRoot = mkdtempSync(join(tmpdir(), "agenc-checkout-permissions-"));
    const linked = join(workRoot, "linked");
    roots.push(workRoot);
    execFileSync("git", ["init", "-q", workRoot]);
    execFileSync("git", ["-C", workRoot, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", workRoot, "config", "user.name", "AgenC Test"]);
    writeFileSync(join(workRoot, "tracked.txt"), "tracked\n");
    execFileSync("git", ["-C", workRoot, "add", "tracked.txt"]);
    execFileSync("git", ["-C", workRoot, "commit", "-qm", "seed"]);
    execFileSync("git", ["-C", workRoot, "worktree", "add", "--no-checkout", linked]);

    const permissions = worktreeCheckoutPermissions(workRoot, linked);
    const paths = permissions.fileSystem?.entries.map((entry) =>
      entry.path.kind === "path" ? entry.path.path : "",
    );
    expect(paths).toContain(linked);
    expect(paths).toHaveLength(2);
    expect(paths).not.toContain(join(workRoot, ".git"));
    expect(paths?.find((path) => path !== linked)).toMatch(
      new RegExp(`${escapeRegExp(join(workRoot, ".git", "worktrees"))}.+`),
    );
  });

  it("names a linked worktree's own .git pointer on macOS only, spelled physically", () => {
    const workRoot = realpathSync(mkdtempSync(join(tmpdir(), "agenc-pointer-permissions-")));
    roots.push(workRoot);
    const repo = join(workRoot, "repo");
    mkdirSync(join(repo, ".agenc-worktrees"), { recursive: true });
    const alias = join(workRoot, "alias");
    symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
    // Before `git worktree add` neither the worktree nor its pointer exists.
    const worktree = join(alias, ".agenc-worktrees", "m5-run");

    expect(linkedWorktreePointerPaths(worktree, "darwin")).toEqual([
      join(repo, ".agenc-worktrees", "m5-run", ".git"),
    ]);
    // The Linux monitor accepts the pointer, and its launcher would make the
    // missing one a directory; no other platform needs the grant.
    expect(linkedWorktreePointerPaths(worktree, "linux")).toEqual([]);
    expect(linkedWorktreePointerPaths(worktree, "win32")).toEqual([]);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
