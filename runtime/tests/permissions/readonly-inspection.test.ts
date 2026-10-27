import { describe, expect, it, vi } from "vitest";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReadOnlyInspectionInvocation, assertReadOnlyShellInvocation, attachReadOnlyInspectionInvocation, attachReadOnlyShellInvocation, inspectReadOnlyCommand, inspectReadOnlyShellCommand, prepareReadOnlyInspectionInvocation, prepareReadOnlyShellInvocation, readOnlyShellRefusal, readReadOnlyInspectionInvocation, readReadOnlyShellInvocation, withSessionPresentationEnvironment } from "../../src/permissions/readonly-inspection.js";
import { analyzeShellRuntimeAccess } from "../../src/tools/runtimes/shell.js";
import type { Tool } from "../../src/tools/types.js";
import { restrictedFileSystemPolicy } from "../../src/sandbox/engine/index.js";
import type { UnifiedExecRuntimeSandbox } from "../../src/unified-exec/types.js";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";

const cwd = "/project";

describe("read-only shell inspection", () => {
  it.each([
    "pwd", "ls -la", "cat 'file with spaces.txt'", "head -n 50 README.md",
    "tail -n 20 README.md", "wc -l README.md", "grep -rn TODO src",
    "rg --files src", "rg -n 'unsafe\\(' src", "git log --oneline -5", "git show HEAD:README.md",
    "git branch --list 'fix/*'", "git ls-files", "git rev-parse --show-toplevel",
  ])("accepts literal inspection: %s", (cmd) => {
    expect(inspectReadOnlyCommand("exec_command", { cmd }, cwd)).toMatchObject({ allowed: true });
  });

  it.each([
    "git branch new-branch", "git branch -- -l", "git branch --abbrev 8",
    "git branch -D old", "git diff --output=result.patch", "git -c core.fsmonitor=evil status",
    "git --exec-path=/project/tools status", "git fetch", "git status; touch marker",
    "sort -o output input", "rg --pre=sh text script", "rg -z text archive.gz",
    "rg --pre text", "ls | head", "cat <(touch marker)", "cat $(touch marker)",
    "cat $HOME/secret", "cat *.ts", "PATH=. git status", "env git status",
    "./git status", "/project/bin/git status", "bash -c 'cat README.md'",
    "node -e 'require(\"fs\").writeFileSync(\"marker\",\"x\")'", "curl https://example.com",
    "find . -exec touch marker ';'", "cat ../../outside", "tail -f README.md", "git log --format=%G?", "git show --pretty=raw", "git branch -l new-branch", "git status --short", "git diff --stat",
  ])("refuses mutation or unbounded execution: %s", (cmd) => {
    expect(inspectReadOnlyCommand("exec_command", { cmd }, cwd)).toMatchObject({ allowed: false });
  });

  it.each([
    { shell: "/bin/bash" }, { login: true }, { tty: true },
    { sandbox_permissions: "require_escalated" }, { additional_permissions: { file_system: { write: ["/"] } } },
    { workdir: "/elsewhere" },
  ])("rejects execution overrides: %j", (extra) => {
    expect(inspectReadOnlyCommand("exec_command", { cmd: "cat README.md", ...extra }, cwd)).toMatchObject({ allowed: false });
  });

  it("normalizes direct bash arguments without hiding path operands", () => {
    expect(inspectReadOnlyCommand("system.bash", { command: "cat", args: ["README.md"] }, cwd)).toMatchObject({ allowed: true, invocation: { readPaths: [cwd, "/project/README.md"] } });
    expect(inspectReadOnlyCommand("system.bash", { command: "cat", args: ["/elsewhere/secret"] }, cwd)).toMatchObject({ allowed: false });
  });

  it.each(["git branch new-branch", "sort -o output input", "rg --pre=sh pattern script"])(
    "runtime access analysis does not call mutating argv read-only: %s", (cmd) => {
      const tool = { name: "exec_command" } as Tool;
      expect(analyzeShellRuntimeAccess(tool, { cmd }, cwd)).toMatchObject({ knownSafeWhenTargetless: false, indeterminateWrite: true });
    },
  );

  it("separates semantic read targets from child workspace containment", () => {
    expect(inspectReadOnlyCommand("exec_command", { cmd: "cat /etc/passwd" }, cwd)).toMatchObject({ allowed: false });
    expect(analyzeShellRuntimeAccess({ name: "exec_command" } as Tool, { cmd: "cat /etc/passwd" }, cwd)).toMatchObject({ knownSafeWhenTargetless: true, indeterminateRead: false, readTargets: [cwd, "/etc/passwd"] });
  });

  it.skipIf(process.platform === "win32")("uses installed native executables and disables Git callbacks without inherited environment", () => {
    const sandbox: UnifiedExecRuntimeSandbox = { preference: "require", permissionProfile: { fileSystem: restrictedFileSystemPolicy([{ path: { kind: "special", value: { kind: "root" } }, access: "read" }]), network: "disabled" } };
    const inspected = inspectReadOnlyCommand("exec_command", { cmd: "git log --oneline -5" }, process.cwd());
    if (!inspected.allowed) throw new Error(inspected.reason);
    const invocation = prepareReadOnlyInspectionInvocation(inspected.invocation, sandbox);
    expect(invocation.program).toMatch(/^\/(usr\/)?(?:local\/)?bin\/git$/);
    expect(invocation.args).toEqual(expect.arrayContaining(["--no-pager", "core.fsmonitor=false", "core.hooksPath=/dev/null", "--no-ext-diff", "--no-textconv"]));
    for (const name of ["BASH_ENV", "ENV", "NODE_OPTIONS", "LD_PRELOAD", "GIT_CONFIG_COUNT", "GIT_EXEC_PATH", "RIPGREP_CONFIG_PATH"]) expect(invocation.env).not.toHaveProperty(name);
    expect(invocation.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" });
    const args = { cmd: "git log --oneline -5" };
    attachReadOnlyInspectionInvocation(args, invocation);
    expect(readReadOnlyInspectionInvocation(args)).toBe(invocation);
    expect(readReadOnlyInspectionInvocation({ ...args })).toBeUndefined();
    expect(() => assertReadOnlyInspectionInvocation({ ...invocation })).toThrow(/authority is missing/);
    expect(() => prepareReadOnlyInspectionInvocation(inspected.invocation, { ...sandbox, preference: "auto" })).toThrow(/mandatory/);
  });

  it.skipIf(process.platform === "win32")("passes prepared argv directly to process spawn without shell profiles", async () => {
    const sandbox: UnifiedExecRuntimeSandbox = { preference: "require", permissionProfile: { fileSystem: restrictedFileSystemPolicy([{ path: { kind: "special", value: { kind: "root" } }, access: "read" }]), network: "disabled" } };
    const inspected = inspectReadOnlyCommand("exec_command", { cmd: "cat 'file with spaces.txt'" }, process.cwd());
    if (!inspected.allowed) throw new Error(inspected.reason);
    const invocation = prepareReadOnlyInspectionInvocation(inspected.invocation, sandbox);
    const manager = new UnifiedExecProcessManager({ cwd: process.cwd(), baseEnv: {
      PATH: "/home/user/bin:/usr/bin", LANG: "de_DE.UTF-8", LC_COLLATE: "C", TZ: "Europe/Berlin", TIME_STYLE: "long-iso",
      LOCPATH: "/home/user/locale", GCONV_PATH: "/home/user/gconv", LD_PRELOAD: "/home/user/hook.so", BASH_ENV: "/home/user/.env",
    } });
    const wrapped = manager as unknown as { buildSpawnCommand: (input: unknown) => unknown; spawnProcess: (input: unknown) => Promise<never> };
    const build = vi.spyOn(wrapped, "buildSpawnCommand").mockImplementation((input) => input);
    const spawn = vi.spyOn(wrapped, "spawnProcess").mockRejectedValue(new Error("captured before physical execution"));
    await expect(manager.execCommand({ cmd: "cat 'file with spaces.txt'", runtimeSandbox: sandbox, directInvocation: invocation, login: false })).rejects.toThrow("captured before physical execution");
    // The inspection keeps its own fixed environment except for the session's
    // locale and display settings, so collation and dates match the shell.
    const { LANG: _lang, LC_ALL: _all, ...fixed } = invocation.env;
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ program: invocation.program, args: ["file with spaces.txt"], cwd: process.cwd(),
      env: { ...fixed, LANG: "de_DE.UTF-8", LC_COLLATE: "C", TZ: "Europe/Berlin", TIME_STYLE: "long-iso" } }));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ allowDirectBwrap: true, sessionSlot: "inspection" }));
    build.mockRestore();
    spawn.mockRestore();
  });
});

describe("session presentation environment", () => {
  it("takes only the session's locale and display settings into an inspection's environment", () => {
    expect(withSessionPresentationEnvironment({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_PAGER: "" }, {
      LANG: "fr_FR.UTF-8", LANGUAGE: "fr:en", LC_TIME: "en_GB.UTF-8", TZ: "America/New_York", QUOTING_STYLE: "shell-escape",
      BLOCK_SIZE: "'1", LC_ALL: undefined, LOCPATH: "/tmp/locale", GCONV_PATH: "/tmp/gconv", PATH: "/tmp/bin", LD_PRELOAD: "x.so",
      LC_CTYPE: "../../tmp/evil", TIME_STYLE: "+%F\n%T",
    })).toEqual({ PATH: "/usr/bin:/bin", GIT_PAGER: "", LANG: "fr_FR.UTF-8", LANGUAGE: "fr:en", LC_TIME: "en_GB.UTF-8",
      TZ: "America/New_York", QUOTING_STYLE: "shell-escape", BLOCK_SIZE: "'1" });
  });
});

describe("read-only shell command lines", () => {
  const sandbox: UnifiedExecRuntimeSandbox = { preference: "require", permissionProfile: { fileSystem: restrictedFileSystemPolicy([{ path: { kind: "special", value: { kind: "root" } }, access: "read" }]), network: "disabled" } };

  it("classifies a command line with its cwd and refuses shell options", () => {
    expect(inspectReadOnlyShellCommand({ cmd: "cd src && ls | sort", workdir: "pkg" }, cwd)).toEqual({
      allowed: true, invocation: { command: "cd src && ls | sort", cwd: "/project/pkg" } });
    for (const extra of [{ login: true }, { tty: true }, { shell: "/bin/zsh" }, { run_in_background: true },
      { sandbox_permissions: "require_escalated" }, { additional_permissions: {} }, { workdir: 7 }]) {
      expect(inspectReadOnlyShellCommand({ cmd: "ls | head", ...extra }, cwd)).toMatchObject({ allowed: false });
    }
    expect(inspectReadOnlyShellCommand({ cmd: "ls > out" }, cwd)).toMatchObject({ allowed: false, reason: expect.stringContaining("writes a file") });
    expect(inspectReadOnlyShellCommand(["ls"], cwd)).toMatchObject({ allowed: false });
  });

  it("binds a command line to a mandatory no-write, no-network sandbox and refuses copies", () => {
    const inspected = inspectReadOnlyShellCommand({ cmd: "ls | head" }, cwd);
    if (!inspected.allowed) throw new Error(inspected.reason);
    const invocation = prepareReadOnlyShellInvocation(inspected.invocation, sandbox);
    const args = { cmd: "ls | head" };
    attachReadOnlyShellInvocation(args, invocation);
    expect(readReadOnlyShellInvocation(args)).toBe(invocation);
    expect(readReadOnlyShellInvocation({ ...args })).toBeUndefined();
    expect(() => assertReadOnlyShellInvocation({ ...invocation })).toThrow(/authority is missing/);
    expect(() => prepareReadOnlyShellInvocation(inspected.invocation, { ...sandbox, preference: "auto" })).toThrow(/mandatory/);
    expect(() => prepareReadOnlyShellInvocation(inspected.invocation, { ...sandbox, permissionProfile: { ...sandbox.permissionProfile, network: "enabled" } })).toThrow(/no-network/);
    expect(() => prepareReadOnlyShellInvocation(inspected.invocation, { ...sandbox, permissionProfile: { ...sandbox.permissionProfile,
      fileSystem: restrictedFileSystemPolicy([{ path: { kind: "path", path: "/project" }, access: "write" }]) } })).toThrow(/no-write/);
  });

  it.skipIf(process.platform === "win32")("runs a command line only through a system-owned POSIX shell", () => {
    expect(readOnlyShellRefusal("/bin/sh")).toBeUndefined();
    expect(readOnlyShellRefusal("/usr/bin/env")).toMatch(/POSIX sh-family/);
    expect(readOnlyShellRefusal("/nonexistent/bash")).toBeDefined();
    const directory = mkdtempSync(join(tmpdir(), "agenc-readonly-shell-"));
    try {
      const copy = join(directory, "bash");
      copyFileSync("/bin/sh", copy);
      chmodSync(copy, 0o755);
      expect(readOnlyShellRefusal(copy)).toMatch(/system-owned|writable/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("launches through the session shell and environment in its own warm slot", async () => {
    const inspected = inspectReadOnlyShellCommand({ cmd: "cd src && ls | sort", workdir: "." }, process.cwd());
    if (!inspected.allowed) throw new Error(inspected.reason);
    const invocation = prepareReadOnlyShellInvocation(inspected.invocation, sandbox);
    const baseEnv = { PATH: "/home/user/bin:/usr/bin:/bin", LANG: "de_DE.UTF-8", HOME: "/home/user" };
    const manager = new UnifiedExecProcessManager({ cwd: "/somewhere-else", baseEnv, shellPath: "/bin/sh" });
    expect(manager.readOnlyShellAvailable()).toBe(true);
    const wrapped = manager as unknown as { buildSpawnCommand: (input: unknown) => unknown; spawnProcess: (input: unknown) => Promise<never> };
    const build = vi.spyOn(wrapped, "buildSpawnCommand").mockImplementation((input) => input);
    const spawn = vi.spyOn(wrapped, "spawnProcess").mockRejectedValue(new Error("captured before physical execution"));
    const request = { cmd: "cd src && ls | sort", runtimeSandbox: sandbox, readOnlyShell: invocation, workdir: process.cwd() };
    await expect(manager.execCommand(request)).rejects.toThrow("captured before physical execution");
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ program: "/bin/sh", args: ["-c", "cd src && ls | sort"],
      cwd: process.cwd(), runtimeSandbox: sandbox, env: expect.objectContaining(baseEnv) }));
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ allowDirectBwrap: true, sessionSlot: "inspection-shell" }));
    // Nothing else may ride on the classified command line.
    for (const changed of [{ cmd: "rm -rf src" }, { runtimeSandbox: { ...sandbox } }, { login: true }, { shell: "/bin/bash" },
      { tty: true }, { workdir: "/tmp" }, { readOnlyShell: { ...invocation } }]) {
      await expect(manager.execCommand({ ...request, ...changed })).rejects.toThrow(/read-only command line|authority is missing/);
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    const hooked = new UnifiedExecProcessManager({ cwd: process.cwd(), baseEnv: { ...baseEnv, BASH_ENV: "/home/user/.bashenv" }, shellPath: "/bin/sh" });
    expect(hooked.readOnlyShellAvailable()).toBe(false);
    await expect(hooked.execCommand(request)).rejects.toThrow(/startup hooks/);
    build.mockRestore();
    spawn.mockRestore();
  });
});
