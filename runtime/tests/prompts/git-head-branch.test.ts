import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { readGitHeadBranch, type GitHeadBranchRead } from "../../src/prompts/git-head-branch.js";

/** The prompt's git child environment: no GIT_* variables and no global or system config. */
function gitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...extra };
}

function runGit(cwd: string, args: readonly string[], extra?: Record<string, string>) {
  return spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
    cwd,
    env: gitEnvironment(extra),
    encoding: "utf8",
  });
}

function git(cwd: string, ...args: string[]): string {
  const result = runGit(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** What the prompt showed before: the command's output, or `none` when it exits non-zero or prints nothing. */
function gitHeadBranch(cwd: string, extra?: Record<string, string>): GitHeadBranchRead {
  const result = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], extra);
  const name = result.stdout.trim();
  return result.status === 0 && name.length > 0 ? { kind: "branch", name } : { kind: "none" };
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-git-head-")));
  roots.push(root);
  return root;
}

/** A repository at `<root>/<name>` with one commit on `branch`. */
function repository(root: string, branch = "main", name = "repo", ...initArgs: string[]): string {
  const dir = join(root, name);
  git(root, "init", "-q", "-b", branch, ...initArgs, dir);
  git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  return dir;
}

function subdirectory(dir: string, ...parts: string[]): string {
  const path = join(dir, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

/** HEAD -> refs/heads/l<levels> -> ... -> refs/heads/l1 -> refs/heads/main. */
function symrefChain(dir: string, levels: number): string {
  for (let level = 1; level <= levels; level += 1) {
    git(dir, "symbolic-ref", `refs/heads/l${level}`, level === 1 ? "refs/heads/main" : `refs/heads/l${level - 1}`);
  }
  git(dir, "symbolic-ref", "HEAD", `refs/heads/l${levels}`);
  return dir;
}

const branch = (name: string): GitHeadBranchRead => ({ kind: "branch", name });
const none: GitHeadBranchRead = { kind: "none" };

const cases: ReadonlyArray<{ name: string; expected: GitHeadBranchRead; cwd: (root: string) => string }> = [
  { name: "a branch", expected: branch("main"), cwd: (root) => repository(root) },
  { name: "a branch with slashes", expected: branch("feature/x"), cwd: (root) => repository(root, "feature/x") },
  { name: "a subdirectory cwd", expected: branch("main"), cwd: (root) => subdirectory(repository(root), "a", "b") },
  {
    name: "a detached HEAD",
    expected: branch("HEAD"),
    cwd: (root) => {
      const dir = repository(root);
      git(dir, "checkout", "-q", "--detach");
      return dir;
    },
  },
  {
    name: "an unborn branch",
    expected: none,
    cwd: (root) => {
      git(root, "init", "-q", "-b", "main", "repo");
      return join(root, "repo");
    },
  },
  {
    name: "refs only in packed-refs",
    expected: branch("main"),
    cwd: (root) => {
      const dir = repository(root);
      git(dir, "pack-refs", "--all");
      expect(existsSync(join(dir, ".git", "refs", "heads", "main"))).toBe(false);
      return dir;
    },
  },
  {
    name: "a linked worktree",
    expected: branch("wt"),
    cwd: (root) => {
      git(repository(root), "worktree", "add", "-q", "-b", "wt", join(root, "wt"));
      return join(root, "wt");
    },
  },
  {
    name: "a submodule-style .git file with a relative gitdir",
    expected: branch("main"),
    cwd: (root) => {
      const dir = repository(root, "main", "work");
      renameSync(join(dir, ".git"), join(subdirectory(root, "modules"), "work"));
      writeFileSync(join(dir, ".git"), "gitdir: ../modules/work\n");
      return dir;
    },
  },
  { name: "a cwd inside the .git directory", expected: branch("main"), cwd: (root) => join(repository(root), ".git") },
  {
    name: "not a repository",
    expected: none,
    cwd: (root) => {
      const discovered = runGit(root, ["rev-parse", "--git-dir"]);
      expect(discovered.status, "os.tmpdir() must not be inside a git repository").not.toBe(0);
      return subdirectory(root, "empty");
    },
  },
  {
    name: "a tag named like the branch",
    expected: branch("heads/main"),
    cwd: (root) => {
      const dir = repository(root);
      git(dir, "tag", "main");
      return dir;
    },
  },
  {
    name: "a symbolic-ref branch",
    expected: branch("main"),
    cwd: (root) => {
      const dir = repository(root);
      git(dir, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
      git(dir, "symbolic-ref", "HEAD", "refs/heads/alias");
      return dir;
    },
  },
  // Further behaviors the reader claims, each checked against the same git command.
  { name: "a symref chain at git's depth limit", expected: branch("main"), cwd: (root) => symrefChain(repository(root), 3) },
  { name: "a symref chain past git's depth limit", expected: none, cwd: (root) => symrefChain(repository(root), 4) },
  {
    name: "HEAD also resolved as refs/heads/HEAD (git prints nothing)",
    expected: none,
    cwd: (root) => {
      const dir = repository(root);
      git(dir, "update-ref", "refs/heads/HEAD", "HEAD");
      return dir;
    },
  },
  {
    name: "HEAD on a remote-tracking HEAD ref",
    expected: branch("origin"),
    cwd: (root) => {
      const dir = repository(root);
      git(dir, "update-ref", "refs/remotes/origin/HEAD", "HEAD");
      git(dir, "symbolic-ref", "HEAD", "refs/remotes/origin/HEAD");
      return dir;
    },
  },
  {
    name: "a top-level file in .git named like the branch",
    expected: branch("heads/main"),
    cwd: (root) => {
      const dir = repository(root);
      writeFileSync(join(dir, ".git", "main"), `${git(dir, "rev-parse", "HEAD")}\n`);
      return dir;
    },
  },
  {
    name: "an unborn bare repository (HEAD is also a file in the cwd)",
    expected: branch("HEAD"),
    cwd: (root) => {
      git(root, "init", "-q", "--bare", "-b", "main", "bare.git");
      return join(root, "bare.git");
    },
  },
  {
    name: "an empty .git directory on the way up",
    expected: branch("main"),
    cwd: (root) => {
      const dir = subdirectory(repository(root), "sub");
      mkdirSync(join(dir, ".git"));
      return dir;
    },
  },
  {
    name: "an invalid .git file",
    expected: none,
    cwd: (root) => {
      const dir = subdirectory(repository(root), "sub");
      writeFileSync(join(dir, ".git"), "not a gitfile\n");
      return dir;
    },
  },
  {
    name: "HEAD naming an invalid ref",
    expected: none,
    cwd: (root) => {
      const dir = repository(root);
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/a..b\n");
      return dir;
    },
  },
];

describe("readGitHeadBranch", () => {
  it.each(cases)("matches git rev-parse --abbrev-ref HEAD: $name", ({ expected, cwd }) => {
    const dir = cwd(scratch());
    expect(gitHeadBranch(dir)).toEqual(expected);
    expect(readGitHeadBranch(dir)).toEqual(gitHeadBranch(dir));
  });

  it("matches git in a SHA-256 repository", ({ skip }) => {
    const root = scratch();
    skip(runGit(root, ["init", "-q", "--object-format=sha256", "probe"]).status !== 0, "git lacks SHA-256");
    const dir = repository(root, "main", "repo", "--object-format=sha256");
    expect(gitHeadBranch(dir)).toEqual(branch("main"));
    expect(readGitHeadBranch(dir)).toEqual(gitHeadBranch(dir));
    git(dir, "checkout", "-q", "--detach");
    expect(gitHeadBranch(dir)).toEqual(branch("HEAD"));
    expect(readGitHeadBranch(dir)).toEqual(gitHeadBranch(dir));
  });

  it("refuses a repository another user owns, as git does", ({ skip }) => {
    const euid = process.geteuid?.();
    if (euid === undefined) return skip("no POSIX owner check on this platform");
    const dir = repository(scratch());
    // git's own switch for "owned by someone else"; the reader sees another effective uid.
    expect(gitHeadBranch(dir, { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" })).toEqual(none);
    const spy = vi.spyOn(process, "geteuid").mockReturnValue(euid + 1);
    try {
      expect(readGitHeadBranch(dir)).toEqual(none);
    } finally {
      spy.mockRestore();
    }
    expect(readGitHeadBranch(dir)).toEqual(gitHeadBranch(dir));
  });

  it("leaves a reftable repository to git", ({ skip }) => {
    const root = scratch();
    skip(runGit(root, ["init", "-q", "--ref-format=reftable", "probe"]).status !== 0, "git cannot create reftable");
    const dir = repository(root, "main", "repo", "--ref-format=reftable");
    expect(gitHeadBranch(dir)).toEqual(branch("main"));
    expect(readGitHeadBranch(dir)).toEqual({ kind: "unsupported" });
  });
});
