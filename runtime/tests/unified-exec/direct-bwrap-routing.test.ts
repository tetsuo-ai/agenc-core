import * as cp from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedExecRuntimeSandbox, UnifiedExecSandboxManager } from "../../src/unified-exec/types.js";
import { prepareReadOnlyInspectionInvocation } from "../../src/permissions/readonly-inspection.js";

vi.mock("../../src/utils/supervisedProcess.js", async original => ({
  ...await original<typeof import("../../src/utils/supervisedProcess.js")>(),
  spawnContainedProcess: vi.fn(() => { throw new Error("route captured"); }),
}));
const { spawnContainedProcess } = await import("../../src/utils/supervisedProcess.js");
const { UnifiedExecProcessManager } = await import("../../src/unified-exec/process-manager.js");
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "direct-routing-")); });
afterEach(() => { vi.restoreAllMocks(); vi.mocked(spawnContainedProcess).mockClear(); rmSync(root, { recursive: true, force: true }); });
const sandboxManager: UnifiedExecSandboxManager = {
  selectInitial: () => "linux_seccomp",
  transform: request => ({ command: [request.command.program, ...request.command.args],
    cwd: request.command.cwd, env: request.command.env, sandbox: request.sandbox,
    windowsSandboxLevel: request.windowsSandboxLevel,
    windowsSandboxPrivateDesktop: request.windowsSandboxPrivateDesktop,
    permissionProfile: request.permissions, fileSystemSandboxPolicy: request.permissions.fileSystem,
    networkSandboxPolicy: request.permissions.network }),
};
function sandbox(): UnifiedExecRuntimeSandbox {
  return { preference: "require", sandboxPolicyCwd: root, sessionTempRoot: root,
    permissionProfile: { fileSystem: { kind: "restricted", includePlatformDefaults: true,
      entries: [{ path: { kind: "special", value: { kind: "root" } }, access: "read" }] }, network: "disabled" } };
}

describe.runIf(process.platform === "linux")("direct bwrap route exclusions", () => {
  it.each(["ordinary", "wrapper", "delegated", "unsandboxed"] as const)("preserves the %s pipe route", async route => {
    const runtimeSandbox = sandbox();
    const manager = new UnifiedExecProcessManager({ cwd: root, sessionTempRoot: root, sandboxManager,
      ...(route === "wrapper" ? { commandWrapperArgv: ["/usr/bin/env"] } : {}) });
    const directInvocation = route === "delegated" ? prepareReadOnlyInspectionInvocation({ command: "pwd", args: [], cwd: root, readPaths: [] }, runtimeSandbox) : undefined;
    await expect(manager.execCommand({ cmd: "pwd", ...(route === "unsandboxed" ? {} : { runtimeSandbox }),
      ...(directInvocation ? { directInvocation } : {}) })).rejects.toThrow("route captured");
    expect(spawnContainedProcess).toHaveBeenCalledTimes(1);
    const options = vi.mocked(spawnContainedProcess).mock.calls[0]![2];
    if (route === "ordinary") expect(options.directBwrap).toMatchObject({ prepare: expect.any(Function), validateAdmission: expect.any(Function) });
    else expect(options.directBwrap).toBeUndefined();
  });

  it("keeps TTY dispatch on the PTY route", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: root, sessionTempRoot: root, sandboxManager });
    const loadPty = vi.fn(async () => { throw new Error("PTY route captured"); });
    Object.assign(manager, { loadPty });
    await expect(manager.execCommand({ cmd: "pwd", tty: true, runtimeSandbox: sandbox() })).rejects.toThrow("PTY route captured");
    expect(loadPty).toHaveBeenCalledTimes(1); expect(spawnContainedProcess).not.toHaveBeenCalled();
  });

  it("keeps detached dispatch outside the containment/direct path", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: root, sessionTempRoot: root, sandboxManager });
    const spawn = vi.spyOn(cp, "spawn").mockImplementation(() => { throw new Error("detached route captured"); });
    await expect(manager.startDetachedProcess({ cmd: "pwd" })).rejects.toThrow("detached route captured");
    expect(spawn).toHaveBeenCalledTimes(1); expect(spawn.mock.calls[0]![2]).toMatchObject({ detached: true });
    expect(spawnContainedProcess).not.toHaveBeenCalled();
  });
});
