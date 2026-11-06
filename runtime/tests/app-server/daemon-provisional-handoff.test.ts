import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryPrepareProvisionalDaemon } from "../../src/app-server/daemon-provisional-start.js";
import {
  acquireAgenCDaemonLifecycleLock, resolveAgenCDaemonPidPath,
  type AgenCDaemonCliHost,
} from "../../src/app-server/daemon-control.js";

// The real lifecycle lock, unchanged; the wrapper only counts the speculative
// start's short-budget attempts that time out.
const speculativeLockTimeouts = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/app-server/daemon-lifecycle-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app-server/daemon-lifecycle-lock.js")>();
  return {
    ...actual,
    acquireAgenCDaemonLifecycleLock: async (
      ...args: Parameters<typeof actual.acquireAgenCDaemonLifecycleLock>
    ) => {
      try {
        return await actual.acquireAgenCDaemonLifecycleLock(...args);
      } catch (error) {
        if (args[2] !== undefined && (error as { code?: unknown }).code === "AGENC_LOCK_TIMEOUT") {
          speculativeLockTimeouts.count += 1;
        }
        throw error;
      }
    },
  };
});

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
  // The speculative start gives up when its short lifecycle-lock attempt times
  // out, and returns null before it spawns anything; under full-suite load that
  // attempt can miss. Only that timeout is retried. Any other null start still
  // fails here, and the handoff after a successful start is what these cases test.
  speculativeLockTimeouts.count = 0;
  let handle = await tryPrepareProvisionalDaemon(host);
  for (let attempt = 1; handle === null && attempt < 20; attempt++) {
    expect(speculativeLockTimeouts.count).toBe(attempt);
    expect(host.spawnDetachedDaemon).not.toHaveBeenCalled();
    handle = await tryPrepareProvisionalDaemon(host);
  }
  if (speculativeLockTimeouts.count > 0) {
    // Only 20 misses in a row fail, so print each retry for the suite output:
    // a start that usually misses its budget shows up as a trend.
    console.warn(`daemon-provisional-handoff fixture: the speculative start's short lifecycle-lock attempt ` +
      `timed out ${speculativeLockTimeouts.count} time(s) before a start succeeded`);
  }
  expect(handle).not.toBeNull();
  return { host, handle: handle!, cancel, pidPath, alive: () => alive };
}

describe.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("provisional cleanup ownership handoff", () => {
  it.each(["throws", "rejects", "pending"])("notifies after sending ADMIT without waiting for an observer that %s", async (mode) => {
    const f = await fixture();
    const events: string[] = [];
    let acknowledge!: () => void;
    const admission = new Promise<void>(resolve => { acknowledge = resolve; });
    const originalAdmit = f.host.admitProvisionalDaemon!;
    f.host.admitProvisionalDaemon = async pid => {
      events.push("admit-sent");
      await admission;
      return originalAdmit(pid);
    };
    const ready = vi.fn();
    const observerError = new Error("optional observer failed");
    const preload = vi.fn(() => {
      events.push("preload");
      if (mode === "throws") throw observerError;
      if (mode === "rejects") return Promise.reject(observerError);
      return new Promise<void>(() => {});
    });
    const running = f.handle.finish({ stdout: sink, stderr: sink }, ready, preload);
    const observed = expect(running).rejects.toMatchObject({ code: "EACCES" });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(events).toEqual(["admit-sent", "preload"]);
    expect(ready).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.alive()).toBe(true);
    acknowledge();
    await observed;
    expect(preload).toHaveBeenCalledOnce();
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(999991);
    expect(f.alive()).toBe(false);
    await expect(readFile(f.pidPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

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
