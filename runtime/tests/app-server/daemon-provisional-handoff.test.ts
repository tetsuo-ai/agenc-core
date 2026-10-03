import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryPrepareProvisionalDaemon } from "../../src/app-server/daemon-provisional-start.js";
import {
  acquireAgenCDaemonLifecycleLock, resolveAgenCDaemonPidPath,
  type AgenCDaemonCliHost,
} from "../../src/app-server/daemon-control.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(join(root, "daemon.pid"), 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
const sink = { write: () => true };
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "agenc-provisional-handoff-")); roots.push(home);
  const pidPath = resolveAgenCDaemonPidPath({ AGENC_HOME: home });
  let alive = false;
  const cancel = vi.fn(async () => {
    alive = false;
    // Fault injection affects the initial read only. Restoring permission
    // lets canonical identity-checked metadata cleanup finish afterward.
    await chmod(pidPath, 0o600);
  });
  const host: AgenCDaemonCliHost = {
    env: { AGENC_HOME: home }, userHome: home,
    entrypointPath: "/install/bin/agenc.js", execPath: process.execPath,
    pid: process.pid, platform: "linux",
    spawnDetachedDaemon: vi.fn(() => { alive = true; return 999991; }),
    isPidRunning: pid => pid === 999991 && alive,
    readProcessIdentity: pid => pid === 999991 && alive ? "test-owned-start" : null,
    cancelSpawnedDaemon: cancel,
    terminatePid: vi.fn(() => { throw new Error("numeric PID signal is forbidden"); }),
    sleep: async () => {},
    admitProvisionalDaemon: async () => { await chmod(pidPath, 0o000); return true; },
  };
  // Populate the lock substrate before the deliberately short speculative
  // attempt. No owner or daemon metadata is created by this preparation.
  const release = await acquireAgenCDaemonLifecycleLock(host); await release();
  const handle = await tryPrepareProvisionalDaemon(host);
  expect(handle).not.toBeNull();
  return { host, handle: handle!, cancel, pidPath, alive: () => alive };
}

describe.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("provisional cleanup ownership handoff", () => {
  it("cleans the exact owned child when the first post-admission PID read fails", async () => {
    const f = await fixture();
    await expect(f.handle.finish({ stdout: sink, stderr: sink })).rejects.toMatchObject({ code: "EACCES" });
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(999991);
    expect(f.alive()).toBe(false);
    await expect(readFile(f.pidPath)).rejects.toMatchObject({ code: "ENOENT" });
    // Mirrors the route's finally; it must not cancel a second time.
    await f.handle.cancel();
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.host.terminatePid).not.toHaveBeenCalled();
  });

  it("reports both the failed PID read and failed cleanup without claiming exit", async () => {
    const f = await fixture();
    const cleanupError = new Error("exact IPC cleanup acknowledgement failed");
    f.cancel.mockRejectedValueOnce(cleanupError);
    const failure = await f.handle.finish({ stdout: sink, stderr: sink }).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0]).toMatchObject({ code: "EACCES" });
    expect(failure.errors[1]).toBe(cleanupError);
    expect(failure.message).toContain("cleanup could not be verified");
    expect(failure.message).toContain(cleanupError.message);
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(999991);
    expect(f.alive()).toBe(true);
    expect(f.host.terminatePid).not.toHaveBeenCalled();
  });

  it("retains the pre-admission cancellation owner", async () => {
    const f = await fixture();
    await f.handle.cancel();
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(999991);
    expect(f.alive()).toBe(false);
    await expect(readFile(f.pidPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
