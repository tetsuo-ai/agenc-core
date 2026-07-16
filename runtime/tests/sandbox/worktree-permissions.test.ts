import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
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
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
