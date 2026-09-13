import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureWorktreeTurnEvidence, getOrCreateWorktree, removeAgentWorktree } from "../../src/agents/worktree.js";
import type { FileSystemSandboxEntry } from "../../src/sandbox/engine/index.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(external = false, aliased = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-remove-boundary-")));
  roots.push(root);
  const prefix = aliased ? join(root, "alias") : root;
  if (aliased) symlinkSync(root, prefix, "dir");
  const project = join(prefix, "project");
  mkdirSync(project);
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: project, encoding: "utf8" });
  git(["init", "-q"]);
  writeFileSync(join(project, "tracked.txt"), "preserve me\n");
  git(["add", "tracked.txt"]);
  git(["-c", "user.name=AgenC Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "seed"]);
  const broker = explicitDangerBroker.forkForCwd(project);
  const worktree = await getOrCreateWorktree({ gitRoot: project, slug: "target", ...(external ? { workspaceRoot: join(root, "external") } : {}), sandboxExecutionBroker: broker });
  const admin = readFileSync(join(worktree.path, ".git"), "utf8").trim().slice("gitdir: ".length);
  const entries: FileSystemSandboxEntry[] = [
    { path: { kind: "special", value: { kind: "root" } }, access: "read" },
    { path: { kind: "path", path: project }, access: "write" },
  ];
  const bind = () => vi.spyOn(broker, "runtimeSandbox").mockReturnValue({ permissionProfile: { fileSystem: { kind: "restricted", entries }, network: "disabled" }, sandboxPolicyCwd: project, sessionTempRoot: root, preference: "require" });
  return { root, project, git, broker, worktree, admin, entries, bind };
}

describe("worktree removal boundary", () => {
  it.skipIf(process.platform === "win32")("resumes, verifies and removes a worktree under a symlinked workspace prefix", async () => {
    const f = await fixture(false, true);
    const baseCommit = f.git(["rev-parse", "HEAD"]).trim();
    const resumed = await getOrCreateWorktree({ gitRoot: f.project, slug: "target", sandboxExecutionBroker: f.broker });
    expect(resumed.created).toBe(false);
    const evidence = await captureWorktreeTurnEvidence({ locator: resumed, baseCommit, sandboxExecutionBroker: f.broker });
    expect(evidence.state).toBe("unchanged_clean");
    f.bind();
    await removeAgentWorktree({ ...resumed, sandboxExecutionBroker: f.broker });
    expect(existsSync(resumed.path)).toBe(false);
    expect(existsSync(f.admin)).toBe(false);
  });

  it.skipIf(process.platform === "win32").each(["protected-descendant", "target-bind"] as const)("refuses a %s reached through a different workspace spelling", async (kind) => {
    const f = await fixture(false, true);
    f.entries.push(kind === "target-bind"
      ? { path: { kind: "path", path: realpathSync(f.worktree.path) }, access: "write" }
      : { path: { kind: "path", path: realpathSync(join(f.worktree.path, "tracked.txt")) }, access: "read" });
    f.bind();
    const prepare = vi.spyOn(f.broker, "prepareSpawn");
    await expect(removeAgentWorktree({ ...f.worktree, sandboxExecutionBroker: f.broker })).rejects.toThrow(/sandbox mount or protected path/u);
    expect(prepare).not.toHaveBeenCalled();
    expect(readFileSync(join(f.worktree.path, "tracked.txt"), "utf8")).toBe("preserve me\n");
    expect(existsSync(f.admin)).toBe(true);
  });

  it("does not add a self-bind or parent grant to an already writable project target", async () => {
    const f = await fixture();
    const sibling = await getOrCreateWorktree({ gitRoot: f.project, slug: "sibling", sandboxExecutionBroker: f.broker });
    f.bind();
    const prepare = vi.spyOn(f.broker, "prepareSpawn");
    await removeAgentWorktree({ ...f.worktree, sandboxExecutionBroker: f.broker });
    const call = prepare.mock.calls.find(([, command]) => command.args.includes("remove"));
    expect(call).toBeDefined();
    expect(call![1].additionalPermissions?.fileSystem?.entries).toEqual([{ path: { kind: "path", path: join(f.project, ".git") }, access: "write" }]);
    expect(existsSync(f.worktree.path)).toBe(false);
    expect(existsSync(f.admin)).toBe(false);
    expect(readFileSync(join(sibling.path, "tracked.txt"), "utf8")).toBe("preserve me\n");
    expect(f.git(["worktree", "list", "--porcelain"])).toContain(sibling.path);
  });

  for (const kind of ["external-parent", "target-bind", "descendant-deny", "foreign-pointer"] as const) {
    it(`refuses ${kind} before touching files or Git metadata`, async () => {
      const f = await fixture(kind === "external-parent");
      if (kind === "target-bind") f.entries.push({ path: { kind: "path", path: f.worktree.path }, access: "write" });
      if (kind === "descendant-deny") f.entries.push({ path: { kind: "path", path: join(f.worktree.path, "tracked.txt") }, access: "read" });
      if (kind === "foreign-pointer") writeFileSync(join(f.worktree.path, ".git"), `gitdir: ${join(f.root, "foreign-admin")}\n`);
      const marker = readFileSync(join(f.worktree.path, ".git"), "utf8");
      const common = readFileSync(join(f.admin, "commondir"), "utf8");
      f.bind();
      const prepare = vi.spyOn(f.broker, "prepareSpawn");
      await expect(removeAgentWorktree({ ...f.worktree, sandboxExecutionBroker: f.broker })).rejects.toThrow(/refused before mutation/u);
      expect(prepare).not.toHaveBeenCalled();
      expect(readFileSync(join(f.worktree.path, "tracked.txt"), "utf8")).toBe("preserve me\n");
      expect(readFileSync(join(f.worktree.path, ".git"), "utf8")).toBe(marker);
      expect(readFileSync(join(f.admin, "commondir"), "utf8")).toBe(common);
      expect(existsSync(dirname(f.admin))).toBe(true);
    });
  }
});
