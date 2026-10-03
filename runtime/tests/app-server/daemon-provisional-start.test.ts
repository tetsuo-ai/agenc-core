import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireAgenCDaemonLifecycleLock, resolveAgenCDaemonPidPath, resolveAgenCDaemonCookiePath, resolveAgenCDaemonSocketPath,
  startAgenCDaemon, type AgenCDaemonCliHost,
} from "../../src/app-server/daemon-control.js";
import { AGENC_DAEMON_PROVISIONAL_ENV } from "../../src/app-server/daemon-provisional-admission.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agenc-provisional-lock-")); roots.push(root);
  const spawned = vi.fn(() => 999991);
  const host: AgenCDaemonCliHost = {
    env: { AGENC_HOME: root }, userHome: root, entrypointPath: "/install/bin/agenc.js",
    execPath: process.execPath, pid: process.pid, platform: "linux", spawnDetachedDaemon: spawned,
    isPidRunning: () => false, terminatePid: vi.fn(), sleep: async () => {},
  };
  const io = { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } };
  const abort = new AbortController();
  const options = { provisionalStart: { signal: abort.signal }, deferDaemonReadyWaitToCaller: true,
    findLegacyDaemonProcesses: vi.fn(async () => []) };
  return { root, host, io, abort, options, spawned };
}

describe("canonical provisional start transaction", () => {
  it("uses the canonical empty-owner mutation and publishes only its exact child", async () => {
    const f = await fixture();
    expect(await startAgenCDaemon(f.host, f.io, f.options)).toBe(0);
    expect(f.spawned).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      AGENC_DAEMON_RUN: "1", [AGENC_DAEMON_PROVISIONAL_ENV]: "1",
    }));
    expect((await readFile(resolveAgenCDaemonPidPath(f.host.env), "utf8")).trim()).toBe("999991");
    expect(f.options.findLegacyDaemonProcesses).toHaveBeenCalledOnce();
  });
  it.each(["daemon.pid", "daemon.json", "daemon.cookie", "daemon.sock"])("leaves uncertain %s untouched and defers to post-trust start", async name => {
    const f = await fixture();
    const { resolveAgenCDaemonRuntimeInfoPath } = await import("../../src/app-server/daemon-runtime-info.js");
    const path = name === "daemon.json" ? resolveAgenCDaemonRuntimeInfoPath(f.root) :
      name === "daemon.cookie" ? resolveAgenCDaemonCookiePath(f.host.env) :
      name === "daemon.sock" ? resolveAgenCDaemonSocketPath(f.host.env) : resolveAgenCDaemonPidPath(f.host.env);
    await writeFile(path, "uncertain artifact\n");
    expect(await startAgenCDaemon(f.host, f.io, f.options)).toBe(2);
    expect(f.spawned).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("uncertain artifact\n");
    expect(f.host.terminatePid).not.toHaveBeenCalled();
  });
  it("does not adopt or overwrite an untracked owner", async () => {
    const f = await fixture();
    const owner = { pid: 5555, home: f.root } as never;
    f.options.findLegacyDaemonProcesses.mockResolvedValue([owner]);
    expect(await startAgenCDaemon(f.host, f.io, f.options)).toBe(2);
    expect(f.spawned).not.toHaveBeenCalled();
    await expect(readFile(resolveAgenCDaemonPidPath(f.host.env))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("settles bounded contention before fallback and cannot spawn after cancellation", async () => {
    const f = await fixture();
    const release = await acquireAgenCDaemonLifecycleLock(f.host);
    try {
      const attempt = startAgenCDaemon(f.host, f.io, f.options);
      f.abort.abort();
      await expect(attempt).rejects.toMatchObject({ code: "AGENC_LOCK_TIMEOUT" });
      expect(f.spawned).not.toHaveBeenCalled();
    } finally { await release(); }
    const next = await acquireAgenCDaemonLifecycleLock(f.host);
    await next();
    expect(f.spawned).not.toHaveBeenCalled();
  });
  it("checks cancellation after canonical discovery and before spawn", async () => {
    const f = await fixture();
    f.options.findLegacyDaemonProcesses.mockImplementation(async () => { f.abort.abort(); return []; });
    expect(await startAgenCDaemon(f.host, f.io, f.options)).toBe(2);
    expect(f.spawned).not.toHaveBeenCalled();
  });
});
