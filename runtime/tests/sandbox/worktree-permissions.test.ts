import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveGitMetadataRoot,
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
});
