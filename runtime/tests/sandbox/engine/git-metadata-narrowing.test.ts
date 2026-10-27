import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canWritePathWithCwd,
  getWritableRootsWithCwd,
  restrictedFileSystemPolicy,
} from "../../../src/sandbox/engine/policy.js";
import { createExecCommandTool } from "../../../src/tools/system/exec-command.js";

// The default sandbox protects all of `.git`, `.agenc` and `.agents`. For a
// real `.git` directory this narrows to only the paths git executes or follows
// as a pointer, so ordinary branch/add/commit/tag/stash writes (refs, objects,
// index, HEAD, logs, pseudo-refs, message files) succeed without an escalation
// while hooks/config/info/objects-info/modules/worktrees/commondir stay
// read-only. A `.git` gitfile or `.git` symlink is a pointer, not a directory,
// and stays fully protected. See round4/jobs/gt/REPORT.md for the threat analysis.

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-narrow-")));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function workspacePolicy() {
  return restrictedFileSystemPolicy([
    { path: { kind: "path", path: root }, access: "write" },
  ]);
}

/** A real `.git` directory populated like a freshly committed repository. */
function makeGitDir(): string {
  const gitDir = path.join(root, ".git");
  fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "logs", "refs", "heads"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "objects", "pack"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "config"), "[core]\n");
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(gitDir, "info", "exclude"), "");
  return gitDir;
}

const canWrite = (target: string) =>
  canWritePathWithCwd(workspacePolicy(), target, root, root);

describe("narrowed .git write policy (file-tool preflight)", () => {
  it("allows ordinary branch/add/commit/tag/stash data writes", () => {
    makeGitDir();
    const writable = [
      ".git/refs/heads/chore/comet-docs",
      ".git/refs/tags/v1",
      ".git/refs/stash",
      ".git/logs/HEAD",
      ".git/logs/refs/heads/chore/comet-docs",
      ".git/objects/ab/cdef0123456789",
      ".git/objects/pack/pack-abc.pack",
      ".git/index",
      ".git/index.lock",
      ".git/HEAD",
      ".git/ORIG_HEAD",
      ".git/MERGE_HEAD",
      ".git/COMMIT_EDITMSG",
      ".git/MERGE_MSG",
      ".git/TAG_EDITMSG",
      ".git/packed-refs",
      ".git/shallow",
    ];
    for (const rel of writable) {
      expect(canWrite(path.join(root, ...rel.split("/")))).toBe(true);
    }
    // The .git directory entry itself is writable so git can create new
    // top-level data files inside it.
    expect(canWrite(path.join(root, ".git"))).toBe(true);
    // Ordinary workspace files remain writable.
    expect(canWrite(path.join(root, "README.md"))).toBe(true);
  });

  it("keeps every execution-capable and redirecting .git path read-only", () => {
    makeGitDir();
    const protectedPaths = [
      ".git/hooks/pre-commit",
      ".git/hooks/post-checkout",
      ".git/config",
      ".git/config.worktree",
      ".git/info/attributes",
      ".git/info/exclude",
      ".git/objects/info/alternates",
      ".git/commondir",
      ".git/modules/sub/config",
      ".git/modules/sub/hooks/pre-commit",
      ".git/worktrees/wt/config.worktree",
      ".git/worktrees/wt/gitdir",
      ".git/worktrees/wt/commondir",
      ".git/objects/info/http-alternates",
      ".git/remotes/origin",
      ".git/branches/origin",
    ];
    for (const rel of protectedPaths) {
      expect(canWrite(path.join(root, ...rel.split("/")))).toBe(false);
    }
  });

  it("refuses a symlink in a writable .git area that resolves into a protected path", () => {
    const gitDir = makeGitDir();
    // Prompt-injection-style alternate path: a ref name that is actually a
    // symlink to .git/config or .git/hooks. The physical spelling must decide.
    fs.symlinkSync(path.join(gitDir, "config"), path.join(gitDir, "refs", "evil-config"));
    fs.symlinkSync(path.join(gitDir, "hooks"), path.join(gitDir, "refs", "evil-hooks"));
    expect(canWrite(path.join(gitDir, "refs", "evil-config"))).toBe(false);
    expect(canWrite(path.join(gitDir, "refs", "evil-hooks", "pre-commit"))).toBe(false);
    fs.mkdirSync(path.join(gitDir, "remotes"), { recursive: true });
    fs.symlinkSync(path.join(gitDir, "remotes"), path.join(gitDir, "refs", "evil-remotes"));
    expect(canWrite(path.join(gitDir, "refs", "evil-remotes", "origin"))).toBe(false);
    // A symlink from inside .git that resolves outside .git is refused too
    // (fail closed): a .git-lexical write must stay physically inside .git.
    fs.symlinkSync("/etc", path.join(gitDir, "refs", "etc"));
    expect(canWrite(path.join(gitDir, "refs", "etc", "cron.d", "x"))).toBe(false);
  });

  it("keeps a .git gitfile pointer (linked worktree) fully protected", () => {
    // A linked worktree has a `.git` FILE, not a directory. It must not be
    // narrowed: rewriting the pointer redirects all metadata.
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    expect(canWrite(path.join(root, ".git"))).toBe(false);
  });

  it("keeps a .git symlink pointer fully protected", () => {
    // A `.git` symlink is the same class of pointer as a gitfile: following
    // it would admit writes into whatever directory it names, including one
    // outside the workspace (HEAD, objects, or an arbitrary file such as
    // id_rsa when the link names ~/.ssh).
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-symlink-target-")));
    try {
      fs.mkdirSync(path.join(outside, "hooks"), { recursive: true });
      fs.mkdirSync(path.join(outside, "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(outside, "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(path.join(outside, "id_rsa"), "secret\n");
      fs.symlinkSync(outside, path.join(root, ".git"));
      expect(canWrite(path.join(root, ".git"))).toBe(false);
      expect(canWrite(path.join(root, ".git", "HEAD"))).toBe(false);
      expect(canWrite(path.join(root, ".git", "refs", "heads", "main"))).toBe(false);
      expect(canWrite(path.join(root, ".git", "id_rsa"))).toBe(false);
      expect(canWrite(path.join(root, ".git", "hooks", "pre-commit"))).toBe(false);
      const writableRoots = getWritableRootsWithCwd(workspacePolicy(), root, root);
      const workspace = writableRoots.find((entry) => entry.root === root);
      expect(workspace?.readOnlySubpaths).toContain(path.join(root, ".git"));
      expect(workspace?.readOnlySubpaths).not.toContain(path.join(root, ".git", "hooks"));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps an absent .git fully protected (cannot be created with hooks)", () => {
    // No .git on disk yet: stay fully protected so a created .git cannot carry
    // hooks or config.
    expect(canWrite(path.join(root, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(canWrite(path.join(root, ".git", "config"))).toBe(false);
    expect(canWrite(path.join(root, ".git", "refs", "heads", "x"))).toBe(false);
  });

  it("never narrows .agenc or .agents", () => {
    makeGitDir();
    fs.mkdirSync(path.join(root, ".agenc"), { recursive: true });
    fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
    expect(canWrite(path.join(root, ".agenc", "state.json"))).toBe(false);
    expect(canWrite(path.join(root, ".agenc", "memory", "x.md"))).toBe(false);
    expect(canWrite(path.join(root, ".agents", "config.json"))).toBe(false);
  });

  it("surfaces the narrowed carve-outs as the writable root's read-only subpaths", () => {
    const gitDir = makeGitDir();
    const writableRoots = getWritableRootsWithCwd(workspacePolicy(), root, root);
    const workspace = writableRoots.find((entry) => entry.root === root);
    expect(workspace).toBeDefined();
    const subs = workspace?.readOnlySubpaths ?? [];
    // The whole-.git carve-out is replaced by the execution/redirection paths.
    expect(subs).not.toContain(gitDir);
    for (const name of ["hooks", "config", "config.worktree", "info", "modules", "worktrees", "commondir", "remotes", "branches"]) {
      expect(subs).toContain(path.join(gitDir, name));
    }
    expect(subs).toContain(path.join(gitDir, "objects", "info"));
    // commondir is a carve-out (write-refused by the preflight and, when
    // missing, watched by the launcher's created-path monitor).
    expect(subs).toContain(path.join(gitDir, "commondir"));
    expect(canWrite(path.join(gitDir, "commondir"))).toBe(false);
    // .agenc/.agents stay whole-directory carve-outs.
    expect(subs).toContain(path.join(root, ".agenc"));
    expect(subs).toContain(path.join(root, ".agents"));
    // .git itself is not a carve-out (its inert data is writable).
    expect(subs.some((sub) => sub === gitDir)).toBe(false);
  });
});

describe("shell writes to protected .git paths are refused, ordinary and escalated", () => {
  it.each([
    ".git/objects/info/http-alternates",
    ".git/remotes/origin",
    ".git/branches/origin",
    ".git/hooks/pre-commit",
    ".git/config",
  ])("%s", async (rel) => {
    makeGitDir();
    const tool = createExecCommandTool({ cwd: root, unifiedExecManager: {} as never });
    const cmd = `printf 'x\\n' > ${rel}`;
    for (const extra of [
      {},
      { sandbox_permissions: "require_escalated", justification: "Set the repository up?" },
    ]) {
      const failure = await tool.preflight?.({ cmd, workdir: root, ...extra });
      expect(failure?.code).toBe("shell_workspace_write_policy");
    }
  });
});
