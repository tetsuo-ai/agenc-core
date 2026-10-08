import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { SessionSandbox } from "../../src/sandbox/linux-launcher/session-sandbox.js";
import { permissionProfileFromRuntimePermissions, restrictedFileSystemPolicy } from "../../src/sandbox/engine/index.js";
import type { UnifiedExecRuntimeSandbox } from "../../src/unified-exec/types.js";
let root: string, manager: UnifiedExecProcessManager, policy: UnifiedExecRuntimeSandbox;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "manager-session-sandbox-"));
  for (const name of [".git", ".agenc", ".agents", "temp"]) fs.mkdirSync(path.join(root, name));
  manager = new UnifiedExecProcessManager({ cwd: root, sessionTempRoot: path.join(root, "temp"),
    baseEnv: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
  policy = { sandboxPolicyCwd: root, sessionTempRoot: path.join(root, "temp"),
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
    const a = await run(), b = await run();
    expect(a.exitCode).toBe(0); expect(b.stdout).toBe(a.stdout);
    expect(await spawn.mock.results[0]!.value).toBeDefined();
    const disabled = { ...policy, persistentSession: false };
    const c = await run(namespace, { runtimeSandbox: disabled });
    const d = await run(namespace, { runtimeSandbox: disabled });
    expect(c.exitCode).toBe(0); expect(c.stdout).not.toBe(a.stdout); expect(d.stdout).not.toBe(c.stdout);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it("falls back without replay when the persistent launcher is unavailable", async () => {
    vi.spyOn(SessionSandbox.prototype, "spawn").mockResolvedValue(undefined);
    const result = await run("echo once >> effects; cat effects");
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe("once\n");
    expect(fs.readFileSync(path.join(root, "effects"), "utf8")).toBe("once\n");
  });
  it("applies timeouts and cleans detached descendants", async () => {
    const result = await run("setsid sh -c 'sleep 1; echo leaked > leaked' & wait", { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect((await run("sleep 1.1; test ! -f leaked")).exitCode).toBe(0);
  });
  it("retires an idle namespace on turn cancellation and permits a subsequent turn", async () => {
    const controller = new AbortController();
    const a = await run(namespace, { __abortSignal: controller.signal });
    const close = vi.spyOn(SessionSandbox.prototype, "close");
    controller.abort();
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    await close.mock.results[0]!.value;
    const b = await run(); expect(b.exitCode).toBe(0); expect(b.stdout).not.toBe(a.stdout);
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
    const a = await run();
    const token = manager.beginSandboxAuthorityQuiesce();
    await manager.finishSandboxAuthorityQuiesce(token); manager.resumeSandboxAuthorityAfterQuiesce(token);
    const b = await run(); expect(b.stdout).not.toBe(a.stdout);
    await manager.prepareForDurableClose();
    await expect(run()).rejects.toThrow(/durable/);
  });
});
