/**
 * Real-kernel coverage: a workspace whose missing protected metadata path
 * (`.agenc` below a directory that has one, as for any project under a HOME
 * holding ~/.agenc) keeps workspace-write commands in the persistent session
 * sandbox. The created-path monitor gives the same guarantee as the
 * per-command Node launcher: a protected path a command creates is removed
 * and a clean exit fails.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { SessionSandbox } from "../../src/sandbox/linux-launcher/session-sandbox.js";
import * as supervised from "../../src/utils/supervisedProcess.js";
import { permissionProfileFromRuntimePermissions, restrictedFileSystemPolicy } from "../../src/sandbox/engine/index.js";
import type { UnifiedExecRuntimeSandbox } from "../../src/unified-exec/types.js";
import { prepareReadOnlyInspectionInvocation } from "../../src/permissions/readonly-inspection.js";

let base: string, work: string, manager: UnifiedExecProcessManager, policy: UnifiedExecRuntimeSandbox;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "protected-create-session-"));
  work = path.join(base, "work");
  fs.mkdirSync(path.join(work, "temp"), { recursive: true });
  fs.mkdirSync(path.join(base, ".agenc"));
  fs.mkdirSync(path.join(work, ".agents"));
  manager = new UnifiedExecProcessManager({ cwd: work, sessionTempRoot: path.join(work, "temp"),
    baseEnv: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
  policy = { agencLinuxSandboxExe: fileURLToPath(new URL("../../bin/agenc-linux-sandbox", import.meta.url)),
    sandboxPolicyCwd: work, sessionTempRoot: path.join(work, "temp"),
    permissionProfile: permissionProfileFromRuntimePermissions(restrictedFileSystemPolicy([
      { path: { kind: "special", value: { kind: "root" } }, access: "read" },
      { path: { kind: "path", path: work }, access: "write" },
    ]), "disabled") };
});
afterEach(async () => { await manager.closeAll(); vi.restoreAllMocks(); fs.rmSync(base, { recursive: true, force: true }); });
const namespace = "readlink /proc/self/ns/pid";
function run(cmd: string, extra: Record<string, unknown> = {}) {
  return manager.execCommand({ cmd, login: false, runtimeSandbox: policy, yield_time_ms: 2000, ...extra });
}

describe("protected-create targets in the warm session sandbox", () => {
  it("runs workspace-write commands in one namespace and fails the one that creates a protected path", async () => {
    const launch = vi.spyOn(supervised, "spawnContainedProcess");
    const spawn = vi.spyOn(SessionSandbox.prototype, "spawn");
    const first = await run(namespace);
    const write = await run(`printf x > written; ${namespace}`);
    const created = await run("mkdir .agenc && printf ran");
    const createdThenFailed = await run("mkdir .agenc; exit 3");
    const after = await run(`test ! -e .agenc && ${namespace}`);
    expect(first.exitCode).toBe(0);
    expect(write.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(work, "written"), "utf8")).toBe("x");
    // The command ran; creating the protected path failed it and it is gone.
    expect(created.stdout).toBe("ran");
    expect(created.exitCode).toBe(1);
    expect(createdThenFailed.exitCode).toBe(3);
    expect(after.exitCode).toBe(0);
    expect(fs.existsSync(path.join(work, ".agenc"))).toBe(false);
    // Every command ran in the same warm namespace: one launch in total.
    expect(write.stdout).toBe(first.stdout);
    expect(after.stdout).toBe(first.stdout);
    for (const result of spawn.mock.results) expect(await result.value).toBeDefined();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("removes a protected path a still-running command creates before the command ends", async () => {
    const result = await run("mkdir .agenc; sleep 0.5; test -e .agenc && echo still-there || echo removed");
    expect(result.stdout.trim()).toBe("removed");
    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(path.join(work, ".agenc"))).toBe(false);
  });

  it("rebuilds the namespace for a protected path created outside it instead of removing it", async () => {
    const launch = vi.spyOn(supervised, "spawnContainedProcess");
    const spawn = vi.spyOn(SessionSandbox.prototype, "spawn");
    const first = await run(namespace);
    fs.mkdirSync(path.join(work, ".agenc"));
    fs.writeFileSync(path.join(work, ".agenc", "config.toml"), "kept\n");
    const result = await run("cat .agenc/config.toml; touch .agenc/new 2>/dev/null && echo writable || echo protected");
    expect(first.exitCode).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["kept", "protected"]);
    // Both commands ran in a session namespace and the second one needed a new
    // launch: the namespace was rebuilt around the existing path. (Comparing
    // pid namespace numbers cannot show this: the kernel may give the closed
    // namespace's number to its replacement.)
    for (const spawned of spawn.mock.results) expect(await spawned.value).toBeDefined();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(work, ".agenc", "config.toml"), "utf8")).toBe("kept\n");
    expect(fs.existsSync(path.join(work, ".agenc", "new"))).toBe(false);
  });

  it("keeps git work in the warm namespace and refuses its narrowed .git carve-outs", async () => {
    execFileSync("git", ["init", "-q", "-b", "main", work], { stdio: "ignore" });
    const first = await run(namespace);
    const git = "git -c user.email=t@example.test -c user.name=T -c commit.gpgsign=false";
    const commit = await run(`printf x > tracked.txt && ${git} add tracked.txt && ${git} commit -qm init && ${git} switch -qc topic && git rev-parse --verify HEAD >/dev/null && ${namespace}`);
    const pointer = await run("printf ../elsewhere > .git/commondir; printf done");
    const modules = await run("mkdir .git/modules && printf done");
    expect(first.exitCode).toBe(0);
    expect(commit.exitCode, commit.stderr).toBe(0);
    expect(commit.stdout).toBe(first.stdout);
    for (const result of [pointer, modules]) {
      expect(result.stdout).toBe("done");
      expect(result.exitCode).toBe(1);
    }
    expect(fs.existsSync(path.join(work, ".git", "commondir"))).toBe(false);
    expect(fs.existsSync(path.join(work, ".git", "modules"))).toBe(false);
  });

  it("gives per-command launches the same guarantee", async () => {
    // Without a delegated cgroup the per-command route is the direct
    // bubblewrap plan (which now carries the monitored targets); with one it
    // is the Node launcher. Either way the protected path is removed and the
    // clean exit fails.
    const perCommand = { ...policy, persistentSession: false };
    const ok = await run("printf fine", { runtimeSandbox: perCommand });
    const created = await run("mkdir .agenc && printf ran", { runtimeSandbox: perCommand });
    expect(ok.exitCode).toBe(0);
    expect(created.stdout).toBe("ran");
    expect(created.exitCode).toBe(1);
    expect(fs.existsSync(path.join(work, ".agenc"))).toBe(false);
  });

  it("narrows a real .git on the per-command route: inert writes land, its surface stays protected", async () => {
    // A real repository is narrowed (#3172): refs, objects, index, HEAD and other inert data under
    // .git are writable, while the execution and redirection surface (hooks, config, info, modules,
    // worktrees, commondir, objects/info, ...) stays read-only. This is the per-command route
    // (persistentSession false); the warm-session route is covered by "keeps git work ...".
    execFileSync("git", ["init", "-q", "-b", "main", work], { stdio: "ignore" });
    const config = fs.readFileSync(path.join(work, ".git", "config"), "utf8");
    const perCommand = { ...policy, persistentSession: false };
    // Ordinary inert data under .git is writable.
    const ref = await run("printf 0000000000000000000000000000000000000000 > .git/refs/heads/topic && printf wrote", { runtimeSandbox: perCommand });
    expect(ref.stdout).toBe("wrote");
    expect(ref.exitCode).toBe(0);
    expect(fs.existsSync(path.join(work, ".git", "refs", "heads", "topic"))).toBe(true);
    // A missing surface entry created during a command is removed and the clean exit fails.
    const modules = await run("mkdir .git/modules && printf ran", { runtimeSandbox: perCommand });
    expect(modules.stdout).toBe("ran");
    expect(modules.exitCode).toBe(1);
    expect(fs.existsSync(path.join(work, ".git", "modules"))).toBe(false);
    const commondir = await run("printf ../elsewhere > .git/commondir; printf done", { runtimeSandbox: perCommand });
    expect(commondir.stdout).toBe("done");
    expect(commondir.exitCode).toBe(1);
    expect(fs.existsSync(path.join(work, ".git", "commondir"))).toBe(false);
    // An existing surface entry stays read-only.
    const hookWrite = await run("printf x > .git/hooks/pre-commit 2>/dev/null && echo wrote || echo blocked", { runtimeSandbox: perCommand });
    expect(hookWrite.stdout.trim()).toBe("blocked");
    expect(fs.existsSync(path.join(work, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(fs.readFileSync(path.join(work, ".git", "config"), "utf8")).toBe(config);
  });

  it("protects a standalone nested repository's surface on the per-command route", async () => {
    // A nested repo (git init sub) is not a submodule under .git/modules; host
    // git descending into its gitlink runs its hooks and config unsandboxed,
    // so its execution surface is read-only like the top-level .git, while its
    // inert data stays writable.
    execFileSync("git", ["init", "-q", "-b", "main", path.join(work, "sub")], { stdio: "ignore" });
    const nestedConfig = fs.readFileSync(path.join(work, "sub", ".git", "config"), "utf8");
    const perCommand = { ...policy, persistentSession: false };
    const ref = await run("printf 0000000000000000000000000000000000000000 > sub/.git/refs/heads/topic && printf wrote", { runtimeSandbox: perCommand });
    expect(ref.stdout).toBe("wrote");
    expect(ref.exitCode).toBe(0);
    const hookWrite = await run("printf x > sub/.git/hooks/pre-commit 2>/dev/null && echo wrote || echo blocked", { runtimeSandbox: perCommand });
    expect(hookWrite.stdout.trim()).toBe("blocked");
    expect(fs.existsSync(path.join(work, "sub", ".git", "hooks", "pre-commit"))).toBe(false);
    const configWrite = await run("printf '[core]\\n\\tfsmonitor = /evil' > sub/.git/config 2>/dev/null && echo wrote || echo blocked", { runtimeSandbox: perCommand });
    expect(configWrite.stdout.trim()).toBe("blocked");
    expect(fs.readFileSync(path.join(work, "sub", ".git", "config"), "utf8")).toBe(nestedConfig);
  });

  it("keeps a .git that is not a repository fully protected on the per-command route", async () => {
    // An empty .git (no HEAD/objects) is not a repository, so it is not
    // narrowed: it stays fully read-only, as a whole .git was before the
    // narrowing. An inert write under it that a real repo would allow is
    // blocked and leaves nothing on the host, so a confined command cannot
    // seed a repository skeleton under a .git the user never created.
    fs.mkdirSync(path.join(work, ".git"));
    const perCommand = { ...policy, persistentSession: false };
    const inert = await run("printf x > .git/new 2>/dev/null && echo wrote || echo blocked", { runtimeSandbox: perCommand });
    expect(inert.stdout.trim()).toBe("blocked");
    expect(fs.existsSync(path.join(work, ".git", "new"))).toBe(false);
  });
});

describe("read-only commands that run side by side", () => {
  it("each take a warm namespace of their own, reused by the next batch", async () => {
    const readOnly: UnifiedExecRuntimeSandbox = { ...policy, preference: "require", permissionProfile: permissionProfileFromRuntimePermissions(
      restrictedFileSystemPolicy([{ path: { kind: "special", value: { kind: "root" } }, access: "read" }]), "disabled") };
    const inspect = () => {
      const directInvocation = prepareReadOnlyInspectionInvocation(
        { command: "readlink", args: ["/proc/self/ns/pid"], cwd: work, readPaths: [work] }, readOnly);
      return manager.execCommand({ cmd: "readlink /proc/self/ns/pid", runtimeSandbox: readOnly, directInvocation,
        workdir: work, yield_time_ms: 2000 });
    };
    const launch = vi.spyOn(supervised, "spawnContainedProcess");
    const first = await Promise.all([inspect(), inspect(), inspect()]);
    const second = await Promise.all([inspect(), inspect(), inspect()]);
    for (const result of [...first, ...second]) expect(result.exitCode).toBe(0);
    // Three namespaces were started once (one launch each); the second batch
    // reused them instead of falling back to per-command launches.
    expect(launch).toHaveBeenCalledTimes(3);
    const namespaces = new Set(first.map(result => result.stdout));
    expect(namespaces.size).toBe(3);
    expect(new Set(second.map(result => result.stdout))).toEqual(namespaces);
  });
});

