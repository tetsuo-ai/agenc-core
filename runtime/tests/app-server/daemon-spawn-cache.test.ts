import { mkdtempSync, rmSync } from "node:fs";
import module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeDaemonCliHost } from "../../src/app-server/daemon-control.js";

afterEach(() => vi.restoreAllMocks());

describe("daemon spawn compile cache publication", () => {
  it.each([false, true])("publishes before spawn and tolerates publication failure=%s", (fails) => {
    const home = mkdtempSync(join(tmpdir(), "agenc-spawn-cache-"));
    const calls: string[] = [];
    vi.spyOn(module, "getCompileCacheDir").mockReturnValue("/existing/private/cache");
    vi.spyOn(module, "flushCompileCache").mockImplementation(() => {
      calls.push("flush");
      if (fails) throw new Error("cache disk full");
    });
    const child = {
      pid: 4242, connected: false,
      unref() {}, once() { return child; }, on() { return child; },
      off() { return child; }, removeListener() { return child; },
      send() { return true; }, kill() { return true; },
    };
    const host = createNodeDaemonCliHost({
      spawnProcess: (() => { calls.push("spawn"); return child; }) as unknown as typeof spawn,
    });
    try {
      expect(host.spawnDetachedDaemon({ ...process.env, AGENC_HOME: home })).toBe(4242);
      expect(calls).toEqual(["flush", "spawn"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves the actual spawn error after an optional cache failure", () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-spawn-cache-error-"));
    const failure = new Error("spawn EAGAIN");
    vi.spyOn(module, "getCompileCacheDir").mockReturnValue("/existing/private/cache");
    vi.spyOn(module, "flushCompileCache").mockImplementation(() => { throw new Error("cache failure"); });
    const host = createNodeDaemonCliHost({
      spawnProcess: (() => { throw failure; }) as typeof spawn,
    });
    try {
      expect(() => host.spawnDetachedDaemon({ ...process.env, AGENC_HOME: home })).toThrow(failure);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("binds readiness to the retained child and releases it on exit or success", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-spawn-ready-"));
    const children: Array<EventEmitter & { pid: number; token: string; connected: boolean }> = [];
    const host = createNodeDaemonCliHost({
      spawnProcess: ((_command: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = Object.assign(new EventEmitter(), {
          pid: 4242 + children.length, connected: true,
          token: options.env.AGENC_DAEMON_STARTUP_GUARD_TOKEN as string,
          unref() {},
          channel: { unref() {} },
          disconnect() { child.connected = false; child.emit("disconnect"); },
        });
        children.push(child);
        return child;
      }) as unknown as typeof spawn,
    });
    try {
      const firstPid = host.spawnDetachedDaemon({ ...process.env, AGENC_HOME: home });
      const secondPid = host.spawnDetachedDaemon({ ...process.env, AGENC_HOME: home });
      const first = children[0]!;
      const second = children[1]!;
      first.emit("message", { type: "agenc.daemon.startup.ready", token: first.token });
      await expect(host.waitSpawnedDaemonReady?.(firstPid, 50)).resolves.toBe("ready");
      second.emit("message", { type: "agenc.daemon.startup.ready", token: first.token });
      await expect(host.waitSpawnedDaemonReady?.(secondPid, 5)).resolves.toBe("timeout");
      const pending = host.waitSpawnedDaemonReady?.(secondPid, 60_000);
      second.emit("exit", 1);
      await expect(pending).resolves.toBe("closed");
      expect(host.waitSpawnedDaemonReady?.(secondPid, 50)).toBeUndefined();
      host.releaseSpawnedDaemonControl?.(firstPid);
      expect(first.connected).toBe(false);
      expect(first.listenerCount("message")).toBe(0);
      expect(host.waitSpawnedDaemonReady?.(firstPid, 50)).toBeUndefined();
      expect(host.waitSpawnedDaemonReady?.(9999, 50)).toBeUndefined();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
