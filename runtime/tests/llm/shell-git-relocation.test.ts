import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyShellWorkspaceWritePolicy } from "../../src/llm/shell-write-policy.js";

describe("whole Git directory relocation under full bypass", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "agenc-git-relocation-")));
    mkdirSync(join(workspace, "api_bridge_snapshot/.git"), { recursive: true });
    mkdirSync(join(workspace, "api"));
    writeFileSync(join(workspace, "api_bridge_snapshot/.git/HEAD"), "ref: refs/heads/main\n");
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));
  const move = "mv api_bridge_snapshot/.git api/.git";
  function classify(command = move, bypass = true, phase: "preflight" | "execution" = "execution", protectedRoots: string[] = []) {
    return classifyShellWorkspaceWritePolicy({
      toolName: "exec_command", args: { command }, workspaceRoot: workspace,
      allowWorkspaceDeletions: true, bypassesApprovalsAndSandbox: bypass,
      validationPhase: phase, protectedRoots,
    });
  }

  it.each(["preflight", "execution"] as const)("allows the benchmark's metadata restoration at %s", (phase) => {
    const result = classify(move, true, phase);
    expect(result.blocked).toBe(false);
    expect(result.observedTargets).toEqual([
      join(workspace, "api_bridge_snapshot/.git"), join(workspace, "api/.git"),
    ]);
    expect(result.deletionTargets).toEqual([]);
  });

  it("keeps approval-only and ordinary editing modes protected", () => {
    expect(classify(move, false).blocked).toBe(true);
  });

  it("allows the captured cutover command with unrelated expanded cleanup targets", () => {
    const command = `set -e
mv ${workspace}/api_bridge_snapshot/.git ${workspace}/api/.git
rm -rf ${workspace}/api_bridge_snapshot ${workspace}/final_api
mkdir -p /root/migrate_archive && mv ${workspace}/migrate/* /root/migrate_archive/ && rmdir ${workspace}/migrate
cd ${workspace}/api
git status --short
git add -A
git -c user.name='AgenC' -c user.email='agent@example.com' commit -m 'Migrate API from MySQL to PostgreSQL' || true
git log --oneline -3
git status --short
ls -la ${workspace}`;
    expect(classify(command).indeterminate).toBe(true);
    expect(classify(command).blocked).toBe(false);
  });

  it.each([
    "rm -rf api_bridge_snapshot/.git",
    `${move} && rm -rf api/.git`,
    `${move} && printf changed > api/.git/config`,
    "mv api_bridge_snapshot/.git/HEAD api/HEAD",
    "mv api_bridge_snapshot/.git api/git-backup",
    "cp -a api_bridge_snapshot/.git api/.git",
  ])("does not exempt other protected mutations: %s", (command) => {
    expect(classify(command).blocked).toBe(true);
  });

  it("refuses an existing destination, including mv -T replacement", () => {
    mkdirSync(join(workspace, "api/.git"));
    expect(classify().blocked).toBe(true);
    expect(classify("mv -T api_bridge_snapshot/.git api/.git").blocked).toBe(true);
  });

  it.each(["source", "destination", "parent"])("refuses a symlink at the %s", (location) => {
    if (location === "source") {
      renameSync(join(workspace, "api_bridge_snapshot/.git"), join(workspace, "metadata"));
      symlinkSync(join(workspace, "metadata"), join(workspace, "api_bridge_snapshot/.git"));
    } else if (location === "destination") {
      symlinkSync(join(workspace, "missing"), join(workspace, "api/.git"));
    } else {
      rmSync(join(workspace, "api"), { recursive: true });
      symlinkSync(join(workspace, "api_bridge_snapshot"), join(workspace, "api"));
    }
    expect(classify().blocked).toBe(true);
  });

  it("refuses missing source or destination parent and a git worktree pointer file", () => {
    rmSync(join(workspace, "api_bridge_snapshot/.git"), { recursive: true });
    expect(classify().blocked).toBe(true);
    writeFileSync(join(workspace, "api_bridge_snapshot/.git"), "gitdir: /elsewhere\n");
    expect(classify().blocked).toBe(true);
    rmSync(join(workspace, "api_bridge_snapshot/.git"));
    mkdirSync(join(workspace, "api_bridge_snapshot/.git"));
    rmSync(join(workspace, "api"), { recursive: true });
    expect(classify().blocked).toBe(true);
  });

  it("refuses crossing workspace or explicit protected roots", () => {
    expect(classify("mv api_bridge_snapshot/.git ../.git").blocked).toBe(true);
    expect(classify(move, true, "execution", [join(workspace, "api")]).blocked).toBe(true);
    expect(classify(move, true, "execution", [join(workspace, "api_bridge_snapshot/.git")]).blocked).toBe(true);
    mkdirSync(join(workspace, ".agenc"));
    expect(classify("mv api_bridge_snapshot/.git .agenc/.git").blocked).toBe(true);
  });

  it("restores a real repository and exports the changed application against its baseline", () => {
    rmSync(join(workspace, "api_bridge_snapshot/.git"), { recursive: true });
    const source = join(workspace, "api_bridge_snapshot");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git(source, "init", "-q");
    writeFileSync(join(source, "main.py"), "backend = 'mysql'\n");
    git(source, "add", "main.py");
    git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid.test", "commit", "-qm", "baseline");
    const baseline = git(source, "rev-parse", "HEAD").trim();
    writeFileSync(join(workspace, "api/main.py"), "backend = 'postgres'\n");
    expect(classify().blocked).toBe(false);
    execFileSync("sh", ["-c", move], { cwd: workspace });
    expect(git(join(workspace, "api"), "rev-parse", "HEAD").trim()).toBe(baseline);
    git(join(workspace, "api"), "add", "-A");
    expect(git(join(workspace, "api"), "diff", "--binary", baseline)).toContain("+backend = 'postgres'");
    expect(readFileSync(join(workspace, "api/.git/HEAD"), "utf8")).toContain("ref: refs/heads/");
  });
});
