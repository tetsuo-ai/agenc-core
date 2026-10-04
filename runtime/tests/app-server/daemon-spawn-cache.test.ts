import { mkdtempSync, rmSync } from "node:fs";
import module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";
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
});
