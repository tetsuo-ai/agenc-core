import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectGitInfo,
  currentBranchName,
  defaultBranchName,
  dirIsInGitRepo,
  findCanonicalGitRoot,
  findGitRoot,
  getGitRemoteUrls,
  getHasChanges,
  getHeadCommitHash,
  getGitDir,
  getRemoteUrl,
  localGitBranches,
  parseGitRemoteUrls,
  recentCommits,
  resolveRepositoryRoot,
  runGit,
  runGitForStdout,
} from "./git.js";

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "agenc-git-utils-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runGitOk(cwd: string, args: ReadonlyArray<string>): Promise<void> {
  const result = await runGit(args, cwd);
  expect(result.code).toBe(0);
}

async function initRepo(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  const init = await runGit(["init", "--initial-branch=main"], repo);
  if (init.code !== 0) {
    await runGitOk(repo, ["init"]);
    await runGitOk(repo, ["checkout", "-B", "main"]);
  }
  await runGitOk(repo, ["config", "user.name", "AgenC Tester"]);
  await runGitOk(repo, ["config", "user.email", "tester@localhost"]);
}

async function commitAll(repo: string, message: string): Promise<void> {
  await runGitOk(repo, ["add", "."]);
  await runGitOk(repo, ["commit", "-m", message]);
}

describe("git root discovery", () => {
  it("finds a repository marker from nested directories and files", async () => {
    await withTempDir(async (root) => {
      const repo = join(root, "repo");
      const nested = join(repo, "src", "utils");
      const file = join(nested, "git.ts");
      await mkdir(join(repo, ".git"), { recursive: true });
      await mkdir(nested, { recursive: true });
      await writeFile(file, "export {}\n");

      expect(findGitRoot(nested)).toBe(repo);
      expect(findGitRoot(file)).toBe(repo);
      expect(findGitRoot(root)).toBeNull();
    });
  });

  it("canonicalizes linked worktrees back to the owning checkout", async () => {
    await withTempDir(async (root) => {
      const main = join(root, "main");
      const linked = join(root, "linked");
      const worktreeGitDir = join(main, ".git", "worktrees", "linked");

      await mkdir(join(main, ".git"), { recursive: true });
      await mkdir(worktreeGitDir, { recursive: true });
      await mkdir(linked, { recursive: true });
      await writeFile(
        join(linked, ".git"),
        `gitdir: ../main/.git/worktrees/linked\n`,
      );
      await writeFile(join(worktreeGitDir, "commondir"), "../..\n");
      await writeFile(join(worktreeGitDir, "gitdir"), `${join(linked, ".git")}\n`);

      expect(findGitRoot(linked)).toBe(linked);
      expect(findCanonicalGitRoot(linked)).toBe(main);
    });
  });

  it("falls back to the checkout root for malformed or forged worktree metadata", async () => {
    await withTempDir(async (root) => {
      const main = join(root, "main");
      const linked = join(root, "linked");
      const attacker = join(root, "attacker");
      const worktreeGitDir = join(attacker, ".git", "worktrees", "linked");

      await mkdir(join(main, ".git"), { recursive: true });
      await mkdir(worktreeGitDir, { recursive: true });
      await mkdir(linked, { recursive: true });
      await writeFile(
        join(linked, ".git"),
        `gitdir: ../attacker/.git/worktrees/linked\n`,
      );
      await writeFile(join(worktreeGitDir, "commondir"), "../../../main/.git\n");
      await writeFile(join(worktreeGitDir, "gitdir"), `${join(linked, ".git")}\n`);

      expect(findCanonicalGitRoot(linked)).toBe(linked);

      await writeFile(join(worktreeGitDir, "commondir"), "../..\n");
      await writeFile(join(worktreeGitDir, "gitdir"), `${join(main, ".git")}\n`);
      expect(findCanonicalGitRoot(linked)).toBe(linked);
    });
  });
});

describe("subprocess-backed git helpers", () => {
  it("collects branch, commit, remote, status, and log data from a real repo", async () => {
    await withTempDir(async (root) => {
      const repo = join(root, "repo");
      await initRepo(repo);
      await writeFile(join(repo, "tracked.txt"), "tracked\n");
      await commitAll(repo, "initial");
      await runGitOk(repo, ["remote", "add", "origin", join(root, "remote.git")]);

      const head = await runGitForStdout(["rev-parse", "HEAD"], repo);
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      await expect(dirIsInGitRepo(repo)).resolves.toBe(true);
      await expect(resolveRepositoryRoot(repo)).resolves.toBe(repo);
      await expect(getGitDir(repo)).resolves.toBe(join(repo, ".git"));
      await expect(getHeadCommitHash(repo)).resolves.toBe(head);
      await expect(currentBranchName(repo)).resolves.toBe("main");
      await expect(defaultBranchName(repo)).resolves.toBe("main");
      await expect(getHasChanges(repo)).resolves.toBe(false);
      await expect(localGitBranches(repo)).resolves.toEqual(["main"]);
      await expect(getRemoteUrl(repo)).resolves.toBe(join(root, "remote.git"));
      await expect(getGitRemoteUrls(repo)).resolves.toEqual({
        origin: join(root, "remote.git"),
      });

      const info = await collectGitInfo(repo);
      expect(info).toEqual({
        commitHash: head,
        branch: "main",
        repositoryUrl: join(root, "remote.git"),
      });

      await writeFile(join(repo, "dirty.txt"), "dirty\n");
      await expect(getHasChanges(repo)).resolves.toBe(true);

      const commits = await recentCommits(repo, 1);
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({
        sha: head,
        subject: "initial",
      });
      expect(commits[0]?.timestamp).toBeGreaterThan(0);
      await expect(recentCommits(repo, 0)).resolves.toEqual([]);
      await expect(recentCommits(repo, -1)).resolves.toEqual([]);
    });
  });

  it("handles empty repositories and detached HEAD branch state", async () => {
    await withTempDir(async (root) => {
      const emptyRepo = join(root, "empty");
      await initRepo(emptyRepo);

      await expect(collectGitInfo(emptyRepo)).resolves.toMatchObject({
        commitHash: null,
        repositoryUrl: null,
      });
      await expect(getHeadCommitHash(emptyRepo)).resolves.toBeNull();

      const repo = join(root, "repo");
      await initRepo(repo);
      await writeFile(join(repo, "tracked.txt"), "tracked\n");
      await commitAll(repo, "initial");
      await runGitOk(repo, ["checkout", "--detach", "HEAD"]);

      await expect(currentBranchName(repo)).resolves.toBeNull();
      await expect(collectGitInfo(repo)).resolves.toMatchObject({
        branch: null,
      });
    });
  });

  it("prioritizes origin when resolving remote default branches", async () => {
    await withTempDir(async (root) => {
      const repo = join(root, "repo");
      await initRepo(repo);
      await writeFile(join(repo, "tracked.txt"), "tracked\n");
      await commitAll(repo, "initial");
      const head = await runGitForStdout(["rev-parse", "HEAD"], repo);

      await runGitOk(repo, ["branch", "master"]);
      await runGitOk(repo, ["update-ref", "refs/remotes/backup/master", head]);
      await runGitOk(repo, [
        "symbolic-ref",
        "refs/remotes/backup/HEAD",
        "refs/remotes/backup/master",
      ]);
      await runGitOk(repo, ["update-ref", "refs/remotes/origin/main", head]);
      await runGitOk(repo, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      ]);
      await runGitOk(repo, ["remote", "add", "backup", join(root, "backup.git")]);
      await runGitOk(repo, ["remote", "add", "origin", join(root, "origin.git")]);

      await expect(defaultBranchName(repo)).resolves.toBe("main");
      await expect(localGitBranches(repo)).resolves.toEqual(["main", "master"]);
    });
  });

  it("preserves slash-containing remote default branch names", async () => {
    await withTempDir(async (root) => {
      const repo = join(root, "repo");
      await initRepo(repo);
      await writeFile(join(repo, "tracked.txt"), "tracked\n");
      await commitAll(repo, "initial");
      await runGitOk(repo, ["checkout", "-b", "release/2026.05"]);
      const head = await runGitForStdout(["rev-parse", "HEAD"], repo);

      await runGitOk(repo, [
        "update-ref",
        "refs/remotes/origin/release/2026.05",
        head,
      ]);
      await runGitOk(repo, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/release/2026.05",
      ]);
      await runGitOk(repo, ["remote", "add", "origin", join(root, "origin.git")]);

      await expect(defaultBranchName(repo)).resolves.toBe("release/2026.05");
      await expect(localGitBranches(repo)).resolves.toEqual([
        "release/2026.05",
        "main",
      ]);
    });
  });

  it("reports command failures, timeouts, and bounded output", async () => {
    await withTempDir(async (root) => {
      const repo = join(root, "repo");
      await initRepo(repo);
      await writeFile(join(repo, "tracked.txt"), "tracked\n");
      await commitAll(repo, "initial");

      await expect(
        runGitForStdout(["rev-parse", "--verify", "missing-ref"], repo),
      ).rejects.toMatchObject({
        name: "GitCommandError",
        command: "git rev-parse --verify missing-ref",
        code: 128,
      });

      const timeout = await runGit(
        ["-c", "alias.pause=!sleep 1", "pause"],
        repo,
        { timeoutMs: 5 },
      );
      expect(timeout.timedOut).toBe(true);
      expect(timeout.code).not.toBe(0);

      const capped = await runGit(["rev-parse", "HEAD"], repo, {
        maxBufferBytes: 8,
      });
      expect(capped.stdout).toHaveLength(8);
      expect(capped.stdoutTruncated).toBe(true);
      expect(capped.stderrTruncated).toBe(false);

      const spawnFailure = await runGit(["status"], repo, {
        env: { ...process.env, GIT: join(root, "missing-git") },
      });
      expect(spawnFailure.code).toBe(127);
      expect(spawnFailure.stderr).toContain("missing-git");
    });
  });

  it("returns null-ish values outside a git repository", async () => {
    await withTempDir(async (root) => {
      await expect(dirIsInGitRepo(root)).resolves.toBe(false);
      await expect(collectGitInfo(root)).resolves.toBeNull();
      await expect(currentBranchName(root)).resolves.toBeNull();
      await expect(defaultBranchName(root)).resolves.toBeNull();
      await expect(resolveRepositoryRoot(root)).resolves.toBeNull();
      await expect(getGitDir(root)).resolves.toBeNull();
      await expect(getHeadCommitHash(root)).resolves.toBeNull();
      await expect(getHasChanges(root)).resolves.toBeNull();
      await expect(getRemoteUrl(root)).resolves.toBeNull();
      await expect(getGitRemoteUrls(root)).resolves.toBeNull();
      await expect(localGitBranches(root)).resolves.toEqual([]);
      await expect(recentCommits(root, 5)).resolves.toEqual([]);
    });
  });

  it("parses fetch remotes while ignoring push-only lines", () => {
    const parsed = parseGitRemoteUrls(
      [
        "origin\tfile:///tmp/agenc-repo.git (fetch)",
        "origin\tfile:///tmp/agenc-repo.git (push)",
        "backup  file:///tmp/backup.git (fetch)",
        "__proto__  file:///tmp/proto.git (fetch)",
        "constructor  file:///tmp/constructor.git (fetch)",
      ].join("\n"),
    );

    expect(parsed?.backup).toBe("file:///tmp/backup.git");
    expect(parsed?.constructor).toBe("file:///tmp/constructor.git");
    expect(parsed?.origin).toBe("file:///tmp/agenc-repo.git");
    expect(parsed?.__proto__).toBe("file:///tmp/proto.git");
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      "__proto__",
      "backup",
      "constructor",
      "origin",
    ]);
    const remotes = parseGitRemoteUrls("__proto__  file:///tmp/proto.git (fetch)\n");
    expect(Object.getPrototypeOf(remotes)).toBeNull();
    expect(remotes?.__proto__).toBe("file:///tmp/proto.git");
    expect(parseGitRemoteUrls("origin\tfile:///tmp/agenc-repo.git (push)\n")).toBeNull();
  });
});
