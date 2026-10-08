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
let root: string, manager: UnifiedExecProcessManager, policy: UnifiedExecRuntimeSandbox;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "manager-session-sandbox-"));
  for (const name of [".git", ".agenc", ".agents", "temp"]) fs.mkdirSync(path.join(root, name));
  manager = new UnifiedExecProcessManager({ cwd: root, sessionTempRoot: path.join(root, "temp"),
    baseEnv: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
  policy = { agencLinuxSandboxExe: fileURLToPath(new URL("../../bin/agenc-linux-sandbox", import.meta.url)),
    sandboxPolicyCwd: root, sessionTempRoot: path.join(root, "temp"),
    permissionProfile: permissionProfileFromRuntimePermissions(restrictedFileSystemPolicy([
      { path: { kind: "special", value: { kind: "root" } }, access: "read" },
      { path: { kind: "path", path: root }, access: "write" },
    ]), "disabled") };
});
afterEach(async () => { await manager.closeAll(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const namespace = "readlink /proc/self/ns/pid";
function run(cmd = namespace, extra: Record<string, unknown> = {}) {
  return manager.execCommand({ cmd, login: false, runtimeSandbox: policy, yield_time_ms: 1000, ...extra });
}
describe.runIf(process.platform === "linux")("persistent unified exec lifecycle", () => {
  it("uses one namespace by default and keeps the config opt-out on the original launcher", async () => {
    const spawn = vi.spyOn(SessionSandbox.prototype, "spawn");
    const launch = vi.spyOn(supervised, "spawnContainedProcess");
    const a = await run(), b = await run();
    expect(a.exitCode).toBe(0); expect(b.stdout).toBe(a.stdout);
    expect(await spawn.mock.results[0]!.value).toBeDefined();
    expect(launch).toHaveBeenCalledTimes(1);
    const disabled = { ...policy, persistentSession: false };
    const c = await run(namespace, { runtimeSandbox: disabled });
    const d = await run(namespace, { runtimeSandbox: disabled });
    expect(c.exitCode).toBe(0); expect(d.exitCode).toBe(0);
    // A destroyed namespace's inode may be reused immediately. Assert the
    // fresh native launches and their per-command protocol instead of its ID.
    expect(launch).toHaveBeenCalledTimes(3);
    expect(launch.mock.calls[1]![2].directBwrap?.protocol).toBe("v3");
    expect(launch.mock.calls[2]![2].directBwrap?.protocol).toBe("v3");
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it("falls back without replay when the persistent launcher is unavailable", async () => {
    vi.spyOn(SessionSandbox.prototype, "spawn").mockResolvedValue(undefined);
    const result = await run("echo once >> effects; cat effects");
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe("once\n");
    expect(fs.readFileSync(path.join(root, "effects"), "utf8")).toBe("once\n");
  });
  it("caches a failed startup across policy drains and opt-out, logs once, and isolates owners", async () => {
    const launch = vi.spyOn(supervised, "spawnContainedProcess").mockImplementationOnce(() => { throw new Error("broken broker"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = manager.createOwnerLifetime("failed");
    const extra = { ownerId: "failed", ownerBinding: owner.bind() };
    expect((await run("echo first", extra)).stdout).toBe("first\n");
    expect(launch).toHaveBeenCalledTimes(2); // Failed keeper, successful per-command fallback.
    expect((await run("echo next", extra)).stdout).toBe("next\n");
    expect(launch).toHaveBeenCalledTimes(3);
    await run("true", { ...extra, runtimeSandbox: { ...policy, persistentSession: false } });
    const token = manager.beginSandboxAuthorityQuiesce();
    await manager.finishSandboxAuthorityQuiesce(token); manager.resumeSandboxAuthorityAfterQuiesce(token);
    expect((await run("echo after-drain", extra)).stdout).toBe("after-drain\n");
    expect(launch).toHaveBeenCalledTimes(5);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("rest of this session");
    const a = await run(namespace, { ownerId: "other" }), b = await run(namespace, { ownerId: "other" });
    expect(a.stdout).toBe(b.stdout); expect(launch).toHaveBeenCalledTimes(6);
    await owner.prepareForDurableClose();
    const resumed = { ownerId: "failed", ownerBinding: manager.createOwnerLifetime("failed").bind() };
    const c = await run(namespace, resumed), d = await run(namespace, resumed);
    expect(c.stdout).toBe(d.stdout); expect(launch).toHaveBeenCalledTimes(7);
    expect(log).toHaveBeenCalledTimes(1);
  });
  it.each(["owner", "durable", "best-effort", "quiesce"])("still drains fallback processes if cached sandbox close rejects during %s close", async scope => {
    const owner = manager.createOwnerLifetime("closing");
    const extra = { ownerId: "closing", ownerBinding: owner.bind() };
    await run("true", extra);
    // Exercise the ordinary per-command route alongside the cached namespace.
    vi.spyOn(SessionSandbox.prototype, "spawn").mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const a = await run("sleep 30", { ...extra, yield_time_ms: 1 });
    const b = await run("sleep 30", { ...extra, yield_time_ms: 1 });
    expect(a.session_id).toBeDefined(); expect(b.session_id).toBeDefined();
    const realClose = SessionSandbox.prototype.close;
    vi.spyOn(SessionSandbox.prototype, "close").mockImplementationOnce(async function(this: SessionSandbox) {
      await realClose.call(this);
      throw new Error("injected namespace cleanup failure");
    });
    const close = scope === "owner" ? owner.prepareForDurableClose()
      : scope === "durable" ? manager.prepareForDurableClose()
      : scope === "quiesce" ? manager.finishSandboxAuthorityQuiesce(manager.beginSandboxAuthorityQuiesce())
      : manager.closeAll();
    await expect(close).rejects.toThrow(/cleanup/);
    expect(manager.listOwnedProcesses({ ownerId: "closing" }).every(entry => entry.status !== "running")).toBe(true);
    await expect(run("echo unsafe", extra)).rejects.toThrow(/cleanup|durable/);
  });
  it("applies timeouts and cleans detached descendants", async () => {
    const result = await run("setsid sh -c 'sleep 1; echo leaked > leaked' & wait", { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect((await run("sleep 1.1; test ! -f leaked", { yield_time_ms: 3000 })).exitCode).toBe(0);
  });
  it("retires an idle namespace on turn cancellation and permits a subsequent turn", async () => {
    const launch = vi.spyOn(supervised, "spawnContainedProcess");
    const controller = new AbortController();
    const a = await run(namespace, { __abortSignal: controller.signal });
    const close = vi.spyOn(SessionSandbox.prototype, "close");
    controller.abort();
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    await close.mock.results[0]!.value;
    const b = await run(); expect(a.exitCode).toBe(0); expect(b.exitCode).toBe(0);
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it("isolates owners and retires only the closing owner's namespace", async () => {
    const first = manager.createOwnerLifetime("first"), second = manager.createOwnerLifetime("second");
    const one = { ownerId: "first", ownerBinding: first.bind() };
    const two = { ownerId: "second", ownerBinding: second.bind() };
    const a = await run(namespace, one), b = await run(namespace, two);
    expect(a.stdout).not.toBe(b.stdout);
    expect((await run(namespace, one)).stdout).toBe(a.stdout);
    await first.prepareForDurableClose();
    await expect(run("true", one)).rejects.toThrow(/owner/);
    expect((await run(namespace, two)).stdout).toBe(b.stdout);
  });
  it("closes cached namespaces across authority quiesce and durable shutdown", async () => {
    const launch = vi.spyOn(supervised, "spawnContainedProcess");
    const a = await run();
    const token = manager.beginSandboxAuthorityQuiesce();
    await manager.finishSandboxAuthorityQuiesce(token); manager.resumeSandboxAuthorityAfterQuiesce(token);
    const b = await run(); expect(a.exitCode).toBe(0); expect(b.exitCode).toBe(0);
    expect(launch).toHaveBeenCalledTimes(2);
    await manager.prepareForDurableClose();
    await expect(run()).rejects.toThrow(/durable/);
  });
});
