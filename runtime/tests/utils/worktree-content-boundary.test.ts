import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from "../../src/bootstrap/state.js";
import { runWithCwdOverride } from "../../src/utils/cwd.js";
import {
  createAgentWorktree,
  removeAgentWorktree,
} from "../../src/utils/worktree.js";

const originalCwd = getCwdState();
const originalProjectCwd = getOriginalCwd();
const originalAgencHome = process.env.AGENC_HOME;

afterEach(() => {
  setCwdState(originalCwd);
  setOriginalCwd(originalProjectCwd);
  if (originalAgencHome === undefined) {
    delete process.env.AGENC_HOME;
  } else {
    process.env.AGENC_HOME = originalAgencHome;
  }
});

function git(repo: string, args: readonly string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

describe("repository-controlled worktree content boundary", () => {
  test("worktree creation ignores repository capability and secret-copy directives", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-worktree-content-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "tests@example.com"]);
    git(repo, ["config", "user.name", "AgenC Tests"]);

    mkdirSync(join(repo, ".agenc"), { recursive: true });
    mkdirSync(join(repo, ".husky"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(
      join(repo, ".gitignore"),
      [
        ".env",
        "private-cache/",
        ".agenc/config.local.toml",
        ".agenc/worktrees/",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(repo, ".agenc", "config.toml"),
      [
        "config_version = 2",
        "",
        "[worktree]",
        'sparsePaths = ["src"]',
        'symlinkDirectories = ["private-cache"]',
        "",
      ].join("\n"),
    );
    writeFileSync(join(repo, ".worktreeinclude"), ".env\n");
    writeFileSync(join(repo, ".husky", "pre-commit"), "exit 99\n");
    writeFileSync(join(repo, "src", "keep.txt"), "source\n");
    writeFileSync(join(repo, "docs", "keep.txt"), "documentation\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "hostile repository directives"]);

    writeFileSync(join(repo, ".env"), "TOKEN=do-not-copy\n");
    writeFileSync(
      join(repo, ".agenc", "config.local.toml"),
      '[shell_environment_policy.set]\nTOKEN = "do-not-copy"\n',
    );
    mkdirSync(join(repo, "private-cache"), { recursive: true });
    writeFileSync(join(repo, "private-cache", "secret"), "do-not-link\n");

    process.env.AGENC_HOME = join(root, "config-home");
    setOriginalCwd(repo);
    setCwdState(repo);

    let worktree:
      | Awaited<ReturnType<typeof createAgentWorktree>>
      | undefined;
    try {
      worktree = await runWithCwdOverride(repo, () =>
        createAgentWorktree("content-boundary"),
      );

      expect(existsSync(join(worktree.worktreePath, "docs", "keep.txt"))).toBe(
        true,
      );
      expect(existsSync(join(worktree.worktreePath, "private-cache"))).toBe(
        false,
      );
      expect(existsSync(join(worktree.worktreePath, ".env"))).toBe(false);
      expect(
        existsSync(
          join(worktree.worktreePath, ".agenc", "config.local.toml"),
        ),
      ).toBe(false);

      const hooksPath = spawnSync(
        "git",
        ["config", "--local", "--get", "core.hooksPath"],
        { cwd: repo, encoding: "utf8" },
      );
      expect(hooksPath.stdout.trim()).toBe("");
    } finally {
      if (worktree !== undefined) {
        await removeAgentWorktree(
          worktree.worktreePath,
          worktree.worktreeBranch,
          worktree.gitRoot,
        );
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
