import { describe, expect, it, vi } from "vitest";
import { assertReadOnlyInspectionInvocation, attachReadOnlyInspectionInvocation, inspectReadOnlyCommand, prepareReadOnlyInspectionInvocation, readReadOnlyInspectionInvocation } from "../../src/permissions/readonly-inspection.js";
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
    const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
    const wrapped = manager as unknown as { buildSpawnCommand: (input: unknown) => unknown; spawnProcess: (input: unknown) => Promise<never> };
    const build = vi.spyOn(wrapped, "buildSpawnCommand").mockImplementation((input) => input);
    const spawn = vi.spyOn(wrapped, "spawnProcess").mockRejectedValue(new Error("captured before physical execution"));
    await expect(manager.execCommand({ cmd: "cat 'file with spaces.txt'", runtimeSandbox: sandbox, directInvocation: invocation, login: false })).rejects.toThrow("captured before physical execution");
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ program: invocation.program, args: ["file with spaces.txt"], cwd: process.cwd(), env: invocation.env }));
    expect(spawn).toHaveBeenCalledTimes(1);
    build.mockRestore();
    spawn.mockRestore();
  });
});
