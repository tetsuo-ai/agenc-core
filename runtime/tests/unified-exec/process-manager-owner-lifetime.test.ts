import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedExecOwnerBinding, UnifiedExecRuntimeSandbox, UnifiedExecSandboxManager } from "../../src/unified-exec/types.js";

vi.mock("../../src/utils/supervisedProcess.js", async original => ({
  ...await original<typeof import("../../src/utils/supervisedProcess.js")>(),
  spawnContainedProcess: vi.fn(),
  waitForContainedProcessSettlement: vi.fn(async () => {}),
  terminateProcessTreeAndReport: vi.fn(async () => ({ residualProcessesTerminated: false })),
  signalProcessTree: vi.fn((child: EventEmitter) => {
    setImmediate(() => child.emit("exit", null, "SIGTERM"));
  }),
}));
const { spawnContainedProcess, signalProcessTree, terminateProcessTreeAndReport } = await import("../../src/utils/supervisedProcess.js");
const { UnifiedExecProcessManager } = await import("../../src/unified-exec/process-manager.js");
let root: string;
let manager: InstanceType<typeof UnifiedExecProcessManager>;
const sandboxManager: UnifiedExecSandboxManager = {
  selectInitial: () => "linux_seccomp",
  transform: request => ({ command: [request.command.program, ...request.command.args],
    cwd: request.command.cwd, env: request.command.env, sandbox: request.sandbox,
    windowsSandboxLevel: request.windowsSandboxLevel,
    windowsSandboxPrivateDesktop: request.windowsSandboxPrivateDesktop,
    permissionProfile: request.permissions, fileSystemSandboxPolicy: request.permissions.fileSystem,
    networkSandboxPolicy: request.permissions.network }),
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "exec-owner-lifetime-"));
  vi.mocked(spawnContainedProcess).mockImplementation(() => Object.assign(new EventEmitter(), {
    pid: 2147483647, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(), unref() {},
  }) as never);
  manager = new UnifiedExecProcessManager({ cwd: root, sessionTempRoot: root,
    sandboxManager, sandboxAuthorityQuiesceTimeoutMs: 100 });
});
afterEach(async () => {
  await manager.closeAll();
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});
const launch = (ownerId?: string, ownerBinding?: UnifiedExecOwnerBinding) =>
  manager.execCommand({ cmd: "sleep 60", yield_time_ms: 1, ownerId, ownerBinding });

describe("borrowed exec owner lifetimes", () => {
  it("closes only its lifetime, retains killed status, and lets the parent execute", async () => {
    const lifetime = manager.createOwnerLifetime("child");
    const binding = lifetime.bind();
    const child = await launch("child", binding);
    const parent = await launch("parent");
    const foreign = await launch("foreign");
    const legacy = await launch();
    const close = binding.prepareForDurableClose();
    expect(binding.prepareForDurableClose()).toBe(close);
    await expect(launch("child", binding)).rejects.toThrow(/lifetime/);
    await close;
    expect(manager.listOwnedProcesses({ ownerId: "child" })).toEqual([
      expect.objectContaining({ sessionId: child.session_id, status: "killed" }),
    ]);
    for (const [ownerId, result] of [["parent", parent], ["foreign", foreign], [undefined, legacy]] as const) {
      expect(manager.listOwnedProcesses({ ownerId })).toEqual([
        expect.objectContaining({ sessionId: result.session_id, status: "running" }),
      ]);
    }
    await expect(launch("parent")).resolves.toHaveProperty("session_id");
  });

  it("revokes a projection without killing yielded work; the next binding can collect it", async () => {
    const lifetime = manager.createOwnerLifetime("compat");
    const first = lifetime.bind();
    const command = await launch("compat", first);
    first.release();
    const next = lifetime.bind();
    await expect(launch("compat", first)).rejects.toThrow(/lifetime/);
    await expect(first.prepareForDurableClose()).rejects.toThrow(/released/);
    expect(manager.listOwnedProcesses({ ownerId: "compat" })[0]?.status).toBe("running");
    const child = vi.mocked(spawnContainedProcess).mock.results[0]!.value;
    child.stdout.emit("data", Buffer.from("retained output"));
    child.emit("exit", 0, null);
    const result = await manager.writeStdin({ session_id: command.session_id!, ownerId: "compat", ownerBinding: next });
    expect(result.stdout).toBe("retained output");
    expect(result.exitCode).toBe(0);
    await next.prepareForDurableClose();
  });

  it("collects settled output through a closed binding without reopening command or stdin authority", async () => {
    const binding = manager.createOwnerLifetime("child").bind();
    const command = await launch("child", binding);
    vi.mocked(spawnContainedProcess).mock.results[0]!.value.stdout.emit("data", Buffer.from("final child output"));
    await binding.prepareForDurableClose();
    binding.release();
    await expect(launch("child", binding)).rejects.toThrow(/lifetime/);
    await expect(manager.writeStdin({ session_id: command.session_id!, ownerId: "child", ownerBinding: binding,
      chars: "must not write" })).rejects.toThrow(/lifetime/);
    await expect(manager.writeStdin({ session_id: command.session_id!, ownerId: "foreign", ownerBinding: binding })).rejects.toThrow();
    const output = await manager.writeStdin({ session_id: command.session_id!, ownerId: "child", ownerBinding: binding });
    expect(output.stdout).toBe("final child output");
    expect(output.session_id).toBeUndefined();
    await expect(launch("child", binding)).rejects.toThrow(/lifetime/);
  });

  it("rejects overlap, missing tokens, forged tokens and wrong owner or manager", async () => {
    const lifetime = manager.createOwnerLifetime("child");
    const binding = lifetime.bind();
    expect(() => lifetime.bind()).toThrow(/active projection/);
    expect(() => manager.createOwnerLifetime("child")).toThrow(/already open/);
    expect(() => manager.createOwnerLifetime("child", binding)).toThrow(/alias/);
    await expect(launch("child")).rejects.toThrow(/binding/);
    await expect(launch("child", {} as UnifiedExecOwnerBinding)).rejects.toThrow(/binding/);
    await expect(launch("foreign", binding)).rejects.toThrow(/binding/);
    const other = new UnifiedExecProcessManager({ cwd: root, sessionTempRoot: root });
    await expect(other.execCommand({ cmd: "true", ownerId: "child", ownerBinding: binding })).rejects.toThrow(/binding/);
    expect(spawnContainedProcess).not.toHaveBeenCalled();
  });

  it("cannot upgrade old commands or old close callbacks after successful same-id resume", async () => {
    const old = manager.createOwnerLifetime("child");
    const oldBinding = old.bind();
    const oldClose = oldBinding.prepareForDurableClose();
    await oldClose;
    const next = manager.createOwnerLifetime("child").bind();
    await launch("child", next);
    await expect(launch("child", oldBinding)).rejects.toThrow(/lifetime/);
    expect(oldBinding.prepareForDurableClose()).toBe(oldClose);
    await old.prepareForDurableClose();
    expect(manager.listOwnedProcesses({ ownerId: "child" })[0]?.status).toBe("running");
    expect(signalProcessTree).not.toHaveBeenCalled();
  });

  it("invalidates a pending PTY load even across successful same-id replacement", async () => {
    const old = manager.createOwnerLifetime("child").bind();
    let finishLoad!: (value: { spawn: ReturnType<typeof vi.fn> }) => void;
    const spawn = vi.fn();
    const loadPty = vi.fn(() => new Promise(resolve => { finishLoad = resolve; }));
    Object.assign(manager, { loadPty });
    const pending = manager.execCommand({ cmd: "true", tty: true, ownerId: "child", ownerBinding: old });
    void pending.catch(() => {});
    expect(loadPty).toHaveBeenCalledOnce();
    await old.prepareForDurableClose();
    manager.createOwnerLifetime("child").bind();
    finishLoad({ spawn });
    await expect(pending).rejects.toThrow(/lifetime/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a captured native handoff after close and replacement", async () => {
    const binding = manager.createOwnerLifetime("child").bind();
    const runtimeSandbox: UnifiedExecRuntimeSandbox = {
      preference: "require", sandboxPolicyCwd: root, sessionTempRoot: root,
      permissionProfile: { fileSystem: { kind: "restricted", includePlatformDefaults: true,
        entries: [{ path: { kind: "special", value: { kind: "root" } }, access: "read" }] }, network: "disabled" },
    };
    await manager.execCommand({ cmd: "true", yield_time_ms: 1, ownerId: "child", ownerBinding: binding, runtimeSandbox });
    const validate = vi.mocked(spawnContainedProcess).mock.calls[0]![2].directBwrap!.validateAdmission!;
    expect(() => validate()).not.toThrow();
    await binding.prepareForDurableClose();
    manager.createOwnerLifetime("child").bind();
    expect(() => validate()).toThrow(/lifetime/);
  });

  it("proves descendant cleanup while leaving sibling authority open", async () => {
    const parent = manager.createOwnerLifetime("parent").bind();
    const child = manager.createOwnerLifetime("child", parent).bind();
    const sibling = manager.createOwnerLifetime("sibling").bind();
    await launch("child", child);
    await parent.prepareForDurableClose();
    await expect(launch("child", child)).rejects.toThrow(/lifetime/);
    await expect(launch("sibling", sibling)).resolves.toHaveProperty("session_id");
    expect(manager.listOwnedProcesses({ ownerId: "child" })[0]?.status).toBe("killed");
  });

  it("keeps failed proof fatal to scoped close, replacement and all shared authority", async () => {
    const binding = manager.createOwnerLifetime("child").bind();
    await launch("child", binding);
    vi.mocked(terminateProcessTreeAndReport).mockRejectedValueOnce(new Error("unproven child cleanup"));
    await expect(binding.prepareForDurableClose()).rejects.toThrow(/cleanup/);
    expect(() => manager.createOwnerLifetime("child")).toThrow(/cleanup/);
    await expect(launch("parent")).rejects.toThrow(/cleanup/);
    await expect(manager.prepareForDurableClose()).rejects.toThrow(/cleanup/);
  });

  it("rejects stale Session teardown after an ancestor closed and replaced its child lifetime", async () => {
    const parent = manager.createOwnerLifetime("parent").bind();
    const child = manager.createOwnerLifetime("child", parent).bind();
    await parent.prepareForDurableClose();
    const replacement = manager.createOwnerLifetime("child").bind();
    expect(() => child.assertCurrent()).toThrow(/released/);
    expect(() => manager.assertOwnerAdmission("child", replacement)).not.toThrow();
  });

  it("global finalization wins over registration, binding and every existing owner", async () => {
    const lifetime = manager.createOwnerLifetime("child");
    const binding = lifetime.bind();
    const close = manager.prepareForDurableClose();
    expect(() => manager.createOwnerLifetime("next")).toThrow(/durable session finalization/);
    binding.release();
    expect(() => lifetime.bind()).toThrow(/durable session finalization/);
    await expect(launch("parent")).rejects.toThrow(/durable session finalization/);
    await close;
  });

  it("denies new detached admission for a closed or revoked binding", async () => {
    const binding = manager.createOwnerLifetime("child").bind();
    binding.release();
    await expect(manager.startDetachedProcess({ cmd: "touch should-not-run", ownerId: "child", ownerBinding: binding })).rejects.toThrow(/binding/);
    await expect(manager.startDetachedProcess({ cmd: "touch should-not-run", ownerId: "child" })).rejects.toThrow(/binding/);
  });
});
