/**
 * Tests for `createGitAndRepoTools` (src/tools/system/git-tools.ts),
 * scoped to `system.repoInventory` / `system.gitStatus` / `system.gitDiff`.
 *
 * Also includes a focused unit test for `parseStatusPorcelain`
 * (src/tools/system/coding-common.ts) as the regression lock for the
 * ahead/behind parsing bug: the prior regex greedily consumed the space
 * before `[`, so the optional ` [ahead N, behind M]` group could never
 * match and ahead/behind were always 0.
 *
 * Coverage:
 *  - parseStatusPorcelain: branch/upstream/ahead/behind/detached + changed
 *    entries for ahead-only, behind-only, both, and no-bracket lines.
 *  - gitStatus: clean repo, dirty repo (staged/unstaged/untracked
 *    partitioning), ahead-count regression against a real remote.
 *  - gitDiff: unstaged hunk, staged diff, empty diff, filePaths filter,
 *    truncated flag, bad fromRef -> error.
 *  - repoInventory: branch, fileCount, topLevelDirectories, manifests,
 *    languages, worktrees.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseStatusPorcelain,
  parseWorktreePorcelain,
} from "src/tools/system/coding-common.js";
import { createGitAndRepoTools } from "./git-tools.js";
import type { Tool } from "../../../src/tools/types.js";

const execFileP = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout;
}

async function setupRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenc-git-tools-"));
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "README.md"), "hello\n", "utf8");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "init");
  return root;
}

function toolByName(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

describe("parseStatusPorcelain (ahead/behind regression)", () => {
  it("parses upstream, ahead, behind, and changed entries", () => {
    const parsed = parseStatusPorcelain(
      "## main...origin/main [ahead 2, behind 3]\n M file.ts\n",
    );
    expect(parsed.branch).toBe("main");
    expect(parsed.upstream).toBe("origin/main");
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(3);
    expect(parsed.detached).toBe(false);
    expect(parsed.changed).toEqual([
      { path: "file.ts", x: " ", y: "M" },
    ]);
  });

  it("parses ahead-only", () => {
    const parsed = parseStatusPorcelain("## main...origin/main [ahead 2]\n");
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(0);
    expect(parsed.upstream).toBe("origin/main");
  });

  it("parses behind-only", () => {
    const parsed = parseStatusPorcelain("## main...origin/main [behind 5]\n");
    expect(parsed.ahead).toBe(0);
    expect(parsed.behind).toBe(5);
  });

  it("parses no-bracket tracking line", () => {
    const parsed = parseStatusPorcelain("## main...origin/main\n");
    expect(parsed.ahead).toBe(0);
    expect(parsed.behind).toBe(0);
    expect(parsed.upstream).toBe("origin/main");
  });

  it("marks detached HEAD", () => {
    const parsed = parseStatusPorcelain("## HEAD (no branch)\n");
    expect(parsed.detached).toBe(true);
    expect(parsed.branch).toBeUndefined();
  });
});

describe("parseWorktreePorcelain", () => {
  it("parses branch, detached, and bare worktree entries", () => {
    const parsed = parseWorktreePorcelain(
      [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /repo-detached",
        "HEAD def456",
        "detached",
        "",
        "worktree /repo-bare",
        "bare",
        "",
      ].join("\n"),
    );

    expect(parsed).toEqual([
      {
        path: "/repo",
        branch: "refs/heads/main",
        head: "abc123",
        detached: false,
        bare: false,
      },
      {
        path: "/repo-detached",
        branch: null,
        head: "def456",
        detached: true,
        bare: false,
      },
      {
        path: "/repo-bare",
        branch: null,
        head: null,
        detached: false,
        bare: true,
      },
    ]);
  });

  it("returns an empty list for empty porcelain output", () => {
    expect(parseWorktreePorcelain("\n")).toEqual([]);
  });
});

describe("createGitAndRepoTools", () => {
  let root: string;
  let persistenceRoot: string;
  let tools: readonly Tool[];

  beforeEach(async () => {
    root = await setupRepo();
    persistenceRoot = await mkdtemp(join(tmpdir(), "agenc-git-tools-persist-"));
    tools = createGitAndRepoTools({
      allowedPaths: [root],
      persistenceRootDir: persistenceRoot,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(persistenceRoot, { recursive: true, force: true });
  });

  describe("system.gitStatus", () => {
    it("returns a clean repo state", async () => {
      const tool = toolByName(tools, "system.gitStatus");
      const result = await tool.execute({ path: root });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content);
      expect(payload.branch).toBe("main");
      expect(payload.detached).toBe(false);
      expect(payload.changed).toEqual([]);
      expect(payload.summary.staged).toEqual([]);
      expect(payload.summary.unstaged).toEqual([]);
      expect(payload.summary.untracked).toEqual([]);
      expect(payload.summary.conflicted).toEqual([]);
    });

    it("partitions staged / unstaged / untracked changes", async () => {
      await writeFile(join(root, "untracked.txt"), "new\n", "utf8");
      await writeFile(join(root, "README.md"), "changed\n", "utf8");
      await writeFile(join(root, "staged.txt"), "s\n", "utf8");
      await git(root, "add", "staged.txt");

      const tool = toolByName(tools, "system.gitStatus");
      const result = await tool.execute({ path: root });
      const payload = JSON.parse(result.content);
      expect(payload.summary.untracked).toContain("untracked.txt");
      expect(payload.summary.unstaged).toContain("README.md");
      expect(payload.summary.staged).toContain("staged.txt");
    });

    it("reports ahead count against a real remote (bug regression)", async () => {
      const remote = await mkdtemp(join(tmpdir(), "agenc-git-tools-remote-"));
      try {
        await git(remote, "init", "--bare", "--initial-branch=main");
        await git(root, "remote", "add", "origin", remote);
        await git(root, "push", "-u", "origin", "main");
        await writeFile(join(root, "README.md"), "a\n", "utf8");
        await git(root, "commit", "-am", "c1");
        await writeFile(join(root, "README.md"), "b\n", "utf8");
        await git(root, "commit", "-am", "c2");

        const tool = toolByName(tools, "system.gitStatus");
        const result = await tool.execute({ path: root });
        const payload = JSON.parse(result.content);
        expect(payload.upstream).toBe("origin/main");
        expect(payload.ahead).toBe(2);
        expect(payload.behind).toBe(0);
      } finally {
        await rm(remote, { recursive: true, force: true });
      }
    });
  });

  describe("system.gitDiff", () => {
    it("returns an unstaged hunk", async () => {
      await writeFile(join(root, "README.md"), "changed\n", "utf8");
      const tool = toolByName(tools, "system.gitDiff");
      const result = await tool.execute({ path: root });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content);
      expect(payload.staged).toBe(false);
      expect(payload.diff).toContain("README.md");
      expect(payload.diff).toContain("changed");
      expect(payload.truncated).toBe(false);
    });

    it("returns a staged diff when staged=true", async () => {
      await writeFile(join(root, "README.md"), "staged-change\n", "utf8");
      await git(root, "add", "README.md");
      const tool = toolByName(tools, "system.gitDiff");
      const result = await tool.execute({ path: root, staged: true });
      const payload = JSON.parse(result.content);
      expect(payload.staged).toBe(true);
      expect(payload.diff).toContain("staged-change");
    });

    it("returns an empty diff without error on a clean tree", async () => {
      const tool = toolByName(tools, "system.gitDiff");
      const result = await tool.execute({ path: root });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content);
      expect(payload.diff).toBe("");
    });

    it("narrows output with a filePaths filter", async () => {
      await writeFile(join(root, "README.md"), "changed\n", "utf8");
      await writeFile(join(root, "other.txt"), "other\n", "utf8");
      await git(root, "add", "other.txt");
      await git(root, "commit", "-m", "add other");
      await writeFile(join(root, "other.txt"), "other-changed\n", "utf8");

      const tool = toolByName(tools, "system.gitDiff");
      const result = await tool.execute({ path: root, filePaths: ["README.md"] });
      const payload = JSON.parse(result.content);
      expect(payload.diff).toContain("README.md");
      expect(payload.diff).not.toContain("other-changed");
    });

    it("returns an error for a bad fromRef", async () => {
      const tool = toolByName(tools, "system.gitDiff");
      const result = await tool.execute({ path: root, fromRef: "does-not-exist-rev" });
      expect(result.isError).toBe(true);
    });

    it("neutralizes an argument-injection fromRef (--output= clobber)", async () => {
      const clobber = join(root, "clobbered.txt");
      const tool = toolByName(tools, "system.gitDiff");
      const result = await tool.execute({ path: root, fromRef: `--output=${clobber}` });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("fromRef must not begin with '-'");
      // The injected --output ref must never reach git, so no file is written.
      await expect(stat(clobber)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("neutralizes an argument-injection toRef", async () => {
      const tool = toolByName(tools, "system.gitDiff");
      const result = await tool.execute({
        path: root,
        fromRef: "HEAD",
        toRef: "--ext-diff",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("toRef must not begin with '-'");
    });
  });

  describe("system.gitShow", () => {
    it("shows a commit by ref", async () => {
      const tool = toolByName(tools, "system.gitShow");
      const result = await tool.execute({ path: root, ref: "HEAD" });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content);
      expect(payload.output).toContain("init");
    });

    it("neutralizes an argument-injection ref (--output= clobber)", async () => {
      const clobber = join(root, "clobbered.txt");
      const tool = toolByName(tools, "system.gitShow");
      const result = await tool.execute({ path: root, ref: `--output=${clobber}` });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("ref must not begin with '-'");
      // The injected --output ref must never reach git, so no file is written.
      await expect(stat(clobber)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("system.gitWorktreeList", () => {
    it("lists worktrees with parsed porcelain fields", async () => {
      const tool = toolByName(tools, "system.gitWorktreeList");
      const result = await tool.execute({ path: root });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content);
      expect(payload.repoRoot).toBe(root);
      expect(payload.worktrees.length).toBeGreaterThanOrEqual(1);
      expect(payload.worktrees[0].path).toBe(root);
      expect(payload.worktrees[0].head).toMatch(/^[0-9a-f]{40}$/);
      expect(payload.worktrees[0].bare).toBe(false);
    });
  });

  describe("system.gitWorktreeCreate", () => {
    it("neutralizes an argument-injection branch (leading '-')", async () => {
      const worktreePath = join(root, "wt-branch");
      const tool = toolByName(tools, "system.gitWorktreeCreate");
      const result = await tool.execute({
        path: root,
        worktreePath,
        branch: "--orphan",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("branch must not begin with '-'");
      // The injected option must never reach git, so no worktree is created.
      await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("neutralizes an argument-injection ref (leading '-')", async () => {
      const worktreePath = join(root, "wt-ref");
      const tool = toolByName(tools, "system.gitWorktreeCreate");
      const result = await tool.execute({
        path: root,
        worktreePath,
        ref: "--lock",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("ref must not begin with '-'");
      await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("creates a worktree for a safe branch", async () => {
      const worktreePath = join(root, "wt-ok");
      const tool = toolByName(tools, "system.gitWorktreeCreate");
      const result = await tool.execute({
        path: root,
        worktreePath,
        branch: "feature",
      });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content);
      expect(payload.branch).toBe("feature");
      expect((await stat(worktreePath)).isDirectory()).toBe(true);
    });
  });

  describe("system.repoInventory", () => {
    it("reports branch, files, directories, manifests, languages, worktrees", async () => {
      await writeFile(join(root, "package.json"), "{}\n", "utf8");
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "index.ts"), "export const x = 1;\n", "utf8");
      await writeFile(join(root, "src", "main.py"), "def f():\n  return 1\n", "utf8");
      await git(root, "add", ".");
      await git(root, "commit", "-m", "add files");

      const tool = toolByName(tools, "system.repoInventory");
      const result = await tool.execute({ path: root });
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content);
      expect(payload.branch).toBe("main");
      expect(payload.fileCount).toBeGreaterThan(0);
      expect(payload.manifests).toContain("package.json");
      expect(payload.topLevelDirectories).toContain("src");
      expect(payload.languages.typescript).toBeGreaterThanOrEqual(1);
      expect(payload.languages.python).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(payload.worktrees)).toBe(true);
      expect(payload.worktrees.length).toBeGreaterThanOrEqual(1);
      expect(payload.worktrees[0].worktree.length).toBeGreaterThan(0);
    });

    it("rejects a path outside allowedPaths", async () => {
      const outside = await mkdtemp(join(tmpdir(), "agenc-git-tools-outside-"));
      try {
        const tool = toolByName(tools, "system.repoInventory");
        const result = await tool.execute({ path: outside });
        expect(result.isError).toBe(true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
