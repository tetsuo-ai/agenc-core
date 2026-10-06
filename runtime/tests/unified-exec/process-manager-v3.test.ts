import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/utils/supervisedProcess.js", async original => ({
  ...await original<typeof import("../../src/utils/supervisedProcess.js")>(),
  spawnContainedProcess: vi.fn(), waitForContainedProcessSettlement: vi.fn(async () => {}),
  terminateProcessTreeAndReport: vi.fn(),
}));
const { spawnContainedProcess, terminateProcessTreeAndReport } = await import("../../src/utils/supervisedProcess.js");
const { UnifiedExecProcessManager } = await import("../../src/unified-exec/process-manager.js");
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "manager-v3-")); });
afterEach(() => { vi.clearAllMocks(); rmSync(root, { recursive: true, force: true }); });
function managerFixture(autoExit = true) {
  vi.mocked(spawnContainedProcess).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 2147483647, exitCode: 125, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(), unref() {} });
    if (autoExit) setImmediate(() => { child.stdout.emit("data", Buffer.from("partial")); child.emit("exit", 125, null); });
    return child as never;
  });
  return new UnifiedExecProcessManager({ cwd: root, sessionTempRoot: root,
    sandboxAuthorityQuiesceTimeoutMs: 25 });
}

describe("unified exec authenticated command outcome", () => {
  it.each(["aborted", "unavailable"] as const)("returns %s as an error outcome with proven quiescence, never a live or no-effect result", async kind => {
    const manager = managerFixture();
    vi.mocked(terminateProcessTreeAndReport).mockResolvedValue({ residualProcessesTerminated: false,
      commandOutcome: { kind, residual: "unknown" } });
    try {
      const result = await manager.execCommand({ cmd: "touch effect", yield_time_ms: 1000 });
      expect(result.exitCode).toBeNull(); expect(result.command_outcome).toBe(kind);
      expect(result.stdout).toBe("partial"); expect(result.process_id).toBeUndefined();
      expect(result.residual_processes_terminated).toBeUndefined(); expect(result.residual_processes_observed).toBeUndefined();
      const token = manager.beginSandboxAuthorityQuiesce();
      await manager.finishSandboxAuthorityQuiesce(token);
      expect(() => manager.resumeSandboxAuthorityAfterQuiesce(token)).not.toThrow();
      await expect(manager.prepareForDurableClose()).resolves.toBeUndefined();
      expect(spawnContainedProcess).toHaveBeenCalledTimes(1);
    } finally { await manager.closeAll("test cleanup"); }
  });

  it.each(["none", "observed"] as const)("propagates authentic command exit and %s observation without claiming termination", async residual => {
    const manager = managerFixture();
    vi.mocked(terminateProcessTreeAndReport).mockResolvedValue({ residualProcessesTerminated: false,
      ...(residual === "observed" ? { residualProcessesObserved: true } : {}),
      commandOutcome: { kind: "reported", result: { kind: "exit", code: 7 }, residual } });
    try {
      const result = await manager.execCommand({ cmd: "exit 7", yield_time_ms: 1000 });
      expect(result.exitCode).toBe(7); expect(result.command_outcome).toBeUndefined();
      expect(result.residual_processes_observed).toBe(residual === "observed" ? true : undefined);
      expect(result.residual_processes_terminated).toBeUndefined();
    } finally { await manager.closeAll("test cleanup"); }
  });

  it("keeps invalid cleanup proof fatal to subsequent authority admission", async () => {
    const manager = managerFixture();
    vi.mocked(terminateProcessTreeAndReport).mockRejectedValue(new Error("invalid outer cleanup proof"));
    const result = await manager.execCommand({ cmd: "touch effect", yield_time_ms: 1000 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not verify descendant process cleanup");
    expect(() => manager.beginSandboxAuthorityQuiesce()).toThrow(/cleanup/);
    await expect(manager.execCommand({ cmd: "true" })).rejects.toThrow();
    expect(spawnContainedProcess).toHaveBeenCalledTimes(1);
    await manager.closeAll("test cleanup").catch(() => {});
    await expect(manager.prepareForDurableClose()).rejects.toThrow(/cleanup/);
  });

  it("freezes admission synchronously and keeps ordinary lifecycle disposal possible", async () => {
    const manager = managerFixture();
    const close = manager.prepareForDurableClose();
    expect(manager.prepareForDurableClose()).toBe(close);
    await expect(manager.execCommand({ cmd: "true" })).rejects.toThrow(/durable session finalization/);
    await expect(close).resolves.toBeUndefined();
    const token = manager.beginSandboxAuthorityQuiesce();
    await manager.finishSandboxAuthorityQuiesce(token);
    manager.resumeSandboxAuthorityAfterQuiesce(token);
    await expect(manager.execCommand({ cmd: "true" })).rejects.toThrow(/durable session finalization/);
    expect(spawnContainedProcess).not.toHaveBeenCalled();
  });

  it("retains an unsettled process across best-effort closeAll and refuses to seal", async () => {
    const manager = managerFixture(false);
    const result = await manager.execCommand({ cmd: "sleep 60", yield_time_ms: 1 });
    expect(result.process_id).toBeDefined();
    await manager.closeAll("best effort timeout");
    const close = manager.prepareForDurableClose();
    await expect(close).rejects.toThrow(/cleanup is unproven at durable close/);
    expect(manager.prepareForDurableClose()).toBe(close);
    await expect(manager.execCommand({ cmd: "true" })).rejects.toThrow(/durable session finalization/);
  });
});
