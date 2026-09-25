import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  PLUGIN_CACHE_LOCK_ACQUIRE_TIMEOUT_MS,
  PLUGIN_CACHE_LOCK_LEASE_TTL_MS,
  acquirePluginCacheLock,
  pluginCacheLockDirectory,
  withPluginCacheLock,
  type PluginCacheLockHooks,
} from "../../src/plugins/plugin-cache-lock.js";

const PROCESS_BUDGET_MS = 120_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("lease duration covers the 120s process budget and stays independent of acquire wait", () => {
  expect(PLUGIN_CACHE_LOCK_LEASE_TTL_MS).toBeGreaterThan(PROCESS_BUDGET_MS);
  expect(PLUGIN_CACHE_LOCK_ACQUIRE_TIMEOUT_MS).not.toBe(PLUGIN_CACHE_LOCK_LEASE_TTL_MS);
});

describe("plugin cache lock leases", () => {
  test("a 120s live owner keeps exclusive ownership without a heartbeat", async () => {
    const { cacheRoot, clock } = await setup();
    const live = new Set(["owner-a", "owner-b"]);
    const ownerA = await acquirePluginCacheLock(cacheRoot, trackedOwner(clock, "owner-a", live));

    clock.advance(PROCESS_BUDGET_MS);

    await expect(acquirePluginCacheLock(
      cacheRoot,
      trackedOwner(clock, "owner-b", live, { acquireTimeoutMs: 0 }),
    )).rejects.toThrow(/timed out waiting for plugin cache lock/u);
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toContain("owner.owner-a");
    await ownerA.release();
  });

  test("a second owner cannot enter while the first heartbeat is current", async () => {
    const { cacheRoot, clock } = await setup();
    const live = new Set(["owner-a", "owner-b"]);
    const ownerA = await acquirePluginCacheLock(
      cacheRoot,
      trackedOwner(clock, "owner-a", live, { leaseTtlMs: 1_000 }),
    );

    clock.advance(900);
    await ownerA.refresh();
    clock.advance(900);

    await expect(acquirePluginCacheLock(
      cacheRoot,
      trackedOwner(clock, "owner-b", live, { acquireTimeoutMs: 0, leaseTtlMs: 1_000 }),
    )).rejects.toThrow(/timed out waiting for plugin cache lock/u);
    await ownerA.release();
  });

  test("a delayed heartbeat past the lease ttl is kept while the pid is alive", async () => {
    const { cacheRoot, clock } = await setup();
    const live = new Set(["owner-a", "owner-b"]);
    const ownerA = await acquirePluginCacheLock(
      cacheRoot,
      trackedOwner(clock, "owner-a", live, { leaseTtlMs: 1_000 }),
    );

    clock.advance(5_000);
    await expect(acquirePluginCacheLock(
      cacheRoot,
      trackedOwner(clock, "owner-b", live, { acquireTimeoutMs: 0, leaseTtlMs: 1_000 }),
    )).rejects.toThrow(manualRemoval(cacheRoot));
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual(["owner.owner-a"]);
    await ownerA.release();
  });

  test("a dead owner with a current heartbeat is not reclaimed", async () => {
    const { cacheRoot, clock } = await setup();
    const live = new Set(["owner-a"]);
    const ownerA = await acquirePluginCacheLock(
      cacheRoot,
      trackedOwner(clock, "owner-a", live, { leaseTtlMs: PROCESS_BUDGET_MS }),
    );

    live.delete("owner-a");
    await expect(acquirePluginCacheLock(
      cacheRoot,
      trackedOwner(clock, "owner-b", live, { acquireTimeoutMs: 0, leaseTtlMs: PROCESS_BUDGET_MS }),
    )).rejects.toThrow(manualRemoval(cacheRoot));
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual(["owner.owner-a"]);
    await ownerA.release();
  });

  test("A/B/C: an old owner release cannot drop a replacement lock", async () => {
    const { cacheRoot, clock } = await setup();
    const live = new Set(["owner-a"]);
    const ownerA = await acquirePluginCacheLock(
      cacheRoot,
      trackedOwner(clock, "owner-a", live, { leaseTtlMs: 1_000 }),
    );

    await expect(acquirePluginCacheLock(
      cacheRoot,
      trackedOwner(clock, "owner-b", live, { acquireTimeoutMs: 0, leaseTtlMs: 1_000 }),
    )).rejects.toThrow(/timed out waiting for plugin cache lock/u);

    live.delete("owner-a");
    live.add("owner-b");
    clock.advance(1_000);
    const ownerB = await acquirePluginCacheLock(
      cacheRoot,
      trackedOwner(clock, "owner-b", live, { leaseTtlMs: 1_000 }),
    );

    await ownerA.release();
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual(["owner.owner-b"]);

    await expect(acquirePluginCacheLock(
      cacheRoot,
      trackedOwner(clock, "owner-c", live, { acquireTimeoutMs: 0, leaseTtlMs: 1_000 }),
    )).rejects.toThrow(/timed out waiting for plugin cache lock/u);

    await ownerB.release();
    await expect(access(pluginCacheLockDirectory(cacheRoot))).rejects.toThrow();
  });

  test("withPluginCacheLock releases only its own lease after the operation", async () => {
    const { cacheRoot, clock } = await setup();
    const seen: string[] = [];

    await withPluginCacheLock(cacheRoot, async () => {
      seen.push(...await readdir(pluginCacheLockDirectory(cacheRoot)));
    }, liveOwner(clock, "wrapper"));

    expect(seen).toEqual(["owner.wrapper"]);
    await expect(access(pluginCacheLockDirectory(cacheRoot))).rejects.toThrow();
  });

  test("withPluginCacheLock still compare-and-deletes after the operation throws", async () => {
    const { cacheRoot, clock } = await setup();

    await expect(withPluginCacheLock(cacheRoot, async () => {
      throw new Error("resolution failed");
    }, liveOwner(clock, "wrapper"))).rejects.toThrow("resolution failed");

    await expect(access(pluginCacheLockDirectory(cacheRoot))).rejects.toThrow();
  });

  test("a dead foreign process owner is reclaimed by a later acquirer", async () => {
    const { cacheRoot, root } = await setup();
    const lockDir = pluginCacheLockDirectory(cacheRoot);
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import { mkdir, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      const lockDir = process.argv[1];
      await mkdir(lockDir, { recursive: false, mode: 0o700 });
      await writeFile(join(lockDir, "owner.child-owner"), JSON.stringify({
        ownerToken: "child-owner",
        pid: process.pid,
        heartbeatAtMs: Date.now(),
      }), { mode: 0o600 });
      process.stdout.write("ready");
      await new Promise(() => {});
      `,
      lockDir,
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

    try {
      await waitForChildReady(child);
      await waitForPath(join(lockDir, "owner.child-owner"));
      await expect(acquirePluginCacheLock(cacheRoot, {
        createOwnerToken: () => "parent-blocked",
        acquireTimeoutMs: 0,
        nowMs: () => 0,
        isProcessAlive: (pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "EPERM";
          }
        },
      })).rejects.toThrow(/timed out waiting for plugin cache lock/u);

      child.kill("SIGKILL");
      await waitForChildExit(child);

      const parent = await acquirePluginCacheLock(cacheRoot, {
        createOwnerToken: () => "parent-owner",
        acquireTimeoutMs: 200,
        nowMs: () => Date.now() + PLUGIN_CACHE_LOCK_LEASE_TTL_MS,
        isProcessAlive: (pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "EPERM";
          }
        },
      });
      expect(parent.ownerToken).toBe("parent-owner");
      await expect(readdir(lockDir)).resolves.toEqual(["owner.parent-owner"]);
      await parent.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  test("a heartbeat write error stays inside the lock and does not reject the process", async () => {
    const { cacheRoot, clock } = await setup();
    const rejections: unknown[] = [];
    const onRejection = (error: unknown): void => {
      rejections.push(error);
    };
    process.on("unhandledRejection", onRejection);
    try {
      let writes = 0;
      await withPluginCacheLock(cacheRoot, async () => {
        const deadline = Date.now() + 1_000;
        while (writes < 2 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(writes).toBeGreaterThanOrEqual(2);
      }, {
        ...liveOwner(clock, "wrapper", { heartbeatIntervalMs: 10 }),
        beforeWriteLease: async () => {
          writes += 1;
          if (writes === 1) return;
          throw new Error("heartbeat write failed");
        },
      });
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
    await expect(access(pluginCacheLockDirectory(cacheRoot))).rejects.toThrow();
  });

  test("release waits for an in-flight refresh and does not recreate the lease", async () => {
    const { cacheRoot, clock } = await setup();
    let writes = 0;
    let releaseRefresh: (() => void) | undefined;
    const refreshEntered = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let enteredRefresh: () => void = () => {};
    const refreshWaiting = new Promise<void>((resolve) => {
      enteredRefresh = resolve;
    });
    const owner = await acquirePluginCacheLock(cacheRoot, liveOwner(clock, "owner-a", {
      beforeWriteLease: async () => {
        writes += 1;
        if (writes < 2) return;
        enteredRefresh();
        await refreshEntered;
      },
    }));

    const refresh = owner.refresh();
    await refreshWaiting;
    let released = false;
    const release = owner.release().then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(released).toBe(false);
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toContain("owner.owner-a");
    releaseRefresh?.();
    await Promise.all([refresh, release]);
    await expect(access(pluginCacheLockDirectory(cacheRoot))).rejects.toThrow();
  });

  test("reclaim does not follow a symlinked lock directory", async () => {
    const { cacheRoot, clock, root } = await setup();
    const target = join(root, "outside-target");
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, "owner.victim"), JSON.stringify({
      ownerToken: "victim",
      pid: 4242,
      heartbeatAtMs: 1,
    }));
    await writeFile(join(target, "keep-me"), "stay");
    await symlink(target, pluginCacheLockDirectory(cacheRoot));

    await expect(acquirePluginCacheLock(
      cacheRoot,
      trackedOwner(clock, "owner-b", new Set(["owner-b"]), { acquireTimeoutMs: 0 }),
    )).rejects.toThrow(/timed out waiting for plugin cache lock/u);
    await expect(readFile(join(target, "keep-me"), "utf8")).resolves.toBe("stay");
    await expect(readdir(target)).resolves.toContain("owner.victim");
  });

  test("a lease written into a replaced lock directory is not treated as exclusive", async () => {
    const { cacheRoot, clock } = await setup();
    let swapped = false;
    await expect(acquirePluginCacheLock(cacheRoot, trackedOwner(clock, "owner-b", new Set(["owner-a", "owner-b"]), {
      acquireTimeoutMs: 0,
      beforeWriteLease: async () => {
        if (swapped) return;
        swapped = true;
        const lockDir = pluginCacheLockDirectory(cacheRoot);
        await rm(lockDir, { recursive: true, force: true });
        await mkdir(lockDir, { mode: 0o700 });
        await writeFile(join(lockDir, "owner.owner-a"), JSON.stringify({
          ownerToken: "owner-a",
          pid: tokenPid("owner-a"),
          heartbeatAtMs: clock.nowMs(),
        }));
      },
    }))).rejects.toThrow(/timed out waiting for plugin cache lock/u);
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual(["owner.owner-a"]);
  });

  test("tryAcquire backs off when a competing lease is in the same lock directory", async () => {
    const { cacheRoot, clock } = await setup();
    let planted = false;
    await expect(acquirePluginCacheLock(cacheRoot, trackedOwner(clock, "owner-b", new Set(["owner-a", "owner-b"]), {
      acquireTimeoutMs: 0,
      beforeWriteLease: async () => {
        if (planted) return;
        planted = true;
        await writeFile(join(pluginCacheLockDirectory(cacheRoot), "owner.owner-a"), JSON.stringify({
          ownerToken: "owner-a",
          pid: tokenPid("owner-a"),
          heartbeatAtMs: clock.nowMs(),
        }));
      },
    }))).rejects.toThrow(/timed out waiting for plugin cache lock/u);
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual(["owner.owner-a"]);
  });

  test("an empty lock directory past the grace period is reclaimed", async () => {
    const { cacheRoot, clock } = await setup();
    await mkdir(pluginCacheLockDirectory(cacheRoot), { mode: 0o700 });
    clock.advance(5_000);
    const owner = await acquirePluginCacheLock(cacheRoot, liveOwner(clock, "owner-a", {
      incompleteGraceMs: 1_000,
    }));
    expect(owner.ownerToken).toBe("owner-a");
    await owner.release();
  });

  test("a fresh empty lock directory is left in place", async () => {
    const { cacheRoot, clock } = await setup();
    await mkdir(pluginCacheLockDirectory(cacheRoot), { mode: 0o700 });
    await expect(acquirePluginCacheLock(cacheRoot, liveOwner(clock, "owner-a", {
      acquireTimeoutMs: 0,
      incompleteGraceMs: 1_000,
    }))).rejects.toThrow(/timed out waiting for plugin cache lock/u);
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual([]);
  });

  test("a stale owner temp file is reclaimed and a fresh one is kept", async () => {
    const { cacheRoot, clock } = await setup();
    const lockDir = pluginCacheLockDirectory(cacheRoot);
    await mkdir(lockDir, { mode: 0o700 });
    await writeFile(join(lockDir, "owner.stale.1.tmp"), "{}\n");
    clock.advance(5_000);
    const owner = await acquirePluginCacheLock(cacheRoot, liveOwner(clock, "owner-a", {
      leaseTtlMs: 1_000,
    }));
    await expect(readdir(lockDir)).resolves.toEqual(["owner.owner-a"]);
    await owner.release();

    const fresh = await setup();
    const freshLock = pluginCacheLockDirectory(fresh.cacheRoot);
    await mkdir(freshLock, { mode: 0o700 });
    await writeFile(join(freshLock, "owner.fresh.1.tmp"), "{}\n");
    await expect(acquirePluginCacheLock(fresh.cacheRoot, liveOwner(fresh.clock, "owner-b", {
      acquireTimeoutMs: 0,
      leaseTtlMs: 1_000,
    }))).rejects.toThrow(/timed out waiting for plugin cache lock/u);
    await expect(readdir(freshLock)).resolves.toEqual(["owner.fresh.1.tmp"]);
  });

  test("a stale owner temp file for a live pid is kept", async () => {
    const { cacheRoot, clock } = await setup();
    const lockDir = pluginCacheLockDirectory(cacheRoot);
    await mkdir(lockDir, { mode: 0o700 });
    await writeFile(join(lockDir, "owner.stale.4242.tmp"), "{}\n");
    clock.advance(5_000);
    await expect(acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-b", {
      pid: 4243,
      acquireTimeoutMs: 0,
      leaseTtlMs: 1_000,
      isProcessAlive: (pid) => pid === 4242,
    }))).rejects.toThrow(manualRemoval(cacheRoot));
    await expect(readdir(lockDir)).resolves.toEqual(["owner.stale.4242.tmp"]);
  });

  test("a corrupt owner file past the grace period is kept and a fresh one is kept", async () => {
    const { cacheRoot, clock } = await setup();
    const lockDir = pluginCacheLockDirectory(cacheRoot);
    await mkdir(lockDir, { mode: 0o700 });
    await writeFile(join(lockDir, "owner.corrupt"), "not-json");
    clock.advance(5_000);
    await expect(acquirePluginCacheLock(cacheRoot, liveOwner(clock, "owner-a", {
      acquireTimeoutMs: 0,
      incompleteGraceMs: 1_000,
    }))).rejects.toThrow(manualRemoval(cacheRoot));
    await expect(readdir(lockDir)).resolves.toEqual(["owner.corrupt"]);

    const fresh = await setup();
    const freshLock = pluginCacheLockDirectory(fresh.cacheRoot);
    await mkdir(freshLock, { mode: 0o700 });
    await writeFile(join(freshLock, "owner.corrupt"), "not-json");
    await expect(acquirePluginCacheLock(fresh.cacheRoot, liveOwner(fresh.clock, "owner-b", {
      acquireTimeoutMs: 0,
      incompleteGraceMs: 1_000,
    }))).rejects.toThrow(/timed out waiting for plugin cache lock/u);
    await expect(readdir(freshLock)).resolves.toEqual(["owner.corrupt"]);
  });

  test("a live owner past the lease ttl is not reclaimed and acquire asks for manual removal", async () => {
    const { cacheRoot, clock } = await setup();
    const owner = await acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-a", {
      pid: 4242,
      leaseTtlMs: 1_000,
      isProcessAlive: () => true,
    }));
    clock.advance(5_000);

    await expect(acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-b", {
      pid: 4243,
      acquireTimeoutMs: 0,
      leaseTtlMs: 1_000,
      isProcessAlive: () => true,
    }))).rejects.toThrow(manualRemoval(cacheRoot));
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual(["owner.owner-a"]);
    await owner.release();
  });

  test("a heartbeat rewritten between read and unlink keeps the original owner", async () => {
    const { cacheRoot, clock } = await setup();
    const lockDir = pluginCacheLockDirectory(cacheRoot);
    const owner = await acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-a", {
      pid: 4242,
      leaseTtlMs: 1_000,
      isProcessAlive: () => true,
    }));
    clock.advance(5_000);
    const freshHeartbeatAtMs = clock.nowMs();
    let rewrote = false;

    await expect(acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-b", {
      pid: 4243,
      acquireTimeoutMs: 0,
      leaseTtlMs: 1_000,
      isProcessAlive: () => {
        if (!rewrote) {
          rewrote = true;
          const dest = join(lockDir, "owner.owner-a");
          const temp = `${dest}.4242.tmp`;
          writeFileSync(temp, `${JSON.stringify({
            ownerToken: "owner-a",
            pid: 4242,
            heartbeatAtMs: freshHeartbeatAtMs,
          })}\n`);
          renameSync(temp, dest);
        }
        return false;
      },
    }))).rejects.toThrow(manualRemoval(cacheRoot));

    expect(rewrote).toBe(true);
    await expect(readdir(lockDir)).resolves.toEqual(["owner.owner-a"]);
    const body = JSON.parse(await readFile(join(lockDir, "owner.owner-a"), "utf8")) as {
      heartbeatAtMs: number;
    };
    expect(body.heartbeatAtMs).toBe(freshHeartbeatAtMs);
    await owner.release();
  });

  test("a corrupt owner file is kept and acquire asks for manual removal", async () => {
    const { cacheRoot, clock } = await setup();
    const lockDir = pluginCacheLockDirectory(cacheRoot);
    await mkdir(lockDir, { mode: 0o700 });
    await writeFile(join(lockDir, "owner.corrupt"), "not-json");
    clock.advance(5_000);

    await expect(acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-b", {
      acquireTimeoutMs: 0,
      incompleteGraceMs: 1_000,
      isProcessAlive: () => true,
    }))).rejects.toThrow(manualRemoval(cacheRoot));
    await expect(readdir(lockDir)).resolves.toEqual(["owner.corrupt"]);
  });

  test("a symlinked owner file is kept and acquire asks for manual removal", async () => {
    const { cacheRoot, clock, root } = await setup();
    const lockDir = pluginCacheLockDirectory(cacheRoot);
    const target = join(root, "lease-target");
    await mkdir(lockDir, { mode: 0o700 });
    await writeFile(target, "not-a-lease");
    await symlink(target, join(lockDir, "owner.linked"));
    clock.advance(5_000);

    await expect(acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-b", {
      acquireTimeoutMs: 0,
      incompleteGraceMs: 1_000,
      isProcessAlive: () => true,
    }))).rejects.toThrow(manualRemoval(cacheRoot));
    await expect(readFile(target, "utf8")).resolves.toBe("not-a-lease");
    await expect(readdir(lockDir)).resolves.toEqual(["owner.linked"]);
  });

  test("a false ESRCH after a fresh rewrite still keeps the current heartbeat", async () => {
    const { cacheRoot, clock } = await setup();
    const lockDir = pluginCacheLockDirectory(cacheRoot);
    const ownerA = await acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-a", {
      pid: 4242,
      leaseTtlMs: 1_000,
      isProcessAlive: () => true,
    }));
    clock.advance(1_000);
    const freshHeartbeatAtMs = clock.nowMs();
    let rewrote = false;

    await expect(acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-b", {
      pid: 4243,
      acquireTimeoutMs: 0,
      leaseTtlMs: 1_000,
      isProcessAlive: (pid) => {
        if (pid === 4242 && !rewrote) {
          rewrote = true;
          const dest = join(lockDir, "owner.owner-a");
          const temp = `${dest}.4242.tmp`;
          writeFileSync(temp, `${JSON.stringify({
            ownerToken: "owner-a",
            pid: 4242,
            heartbeatAtMs: freshHeartbeatAtMs,
          })}\n`);
          renameSync(temp, dest);
        }
        return pid !== 4242;
      },
    }))).rejects.toThrow(manualRemoval(cacheRoot));

    expect(rewrote).toBe(true);
    await expect(readdir(lockDir)).resolves.toEqual(["owner.owner-a"]);
    const body = JSON.parse(await readFile(join(lockDir, "owner.owner-a"), "utf8")) as {
      heartbeatAtMs: number;
    };
    expect(body.heartbeatAtMs).toBe(freshHeartbeatAtMs);
    await ownerA.release();
  });

  test("a false ESRCH does not reclaim a current heartbeat or admit a second owner", async () => {
    const { cacheRoot, clock } = await setup();
    let inCriticalSection = false;
    const ownerA = await acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-a", {
      pid: 4242,
      leaseTtlMs: 1_000,
      isProcessAlive: () => true,
    }));
    inCriticalSection = true;
    clock.advance(100);

    await expect(acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-b", {
      pid: 4243,
      acquireTimeoutMs: 0,
      leaseTtlMs: 1_000,
      isProcessAlive: (pid) => pid !== 4242,
    }))).rejects.toThrow(manualRemoval(cacheRoot));

    expect(inCriticalSection).toBe(true);
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual(["owner.owner-a"]);
    await ownerA.refresh();
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual(["owner.owner-a"]);
    inCriticalSection = false;
    await ownerA.release();
  });

  test("an ESRCH pid with an expired heartbeat is reclaimed", async () => {
    const { cacheRoot, clock } = await setup();
    const ownerA = await acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-a", {
      pid: 4242,
      leaseTtlMs: 1_000,
      isProcessAlive: () => true,
    }));
    clock.advance(1_000);
    const ownerB = await acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-b", {
      pid: 4243,
      leaseTtlMs: 1_000,
      isProcessAlive: (pid) => pid !== 4242,
    }));
    expect(ownerB.ownerToken).toBe("owner-b");
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual(["owner.owner-b"]);
    await ownerA.release();
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual(["owner.owner-b"]);
    await ownerB.release();
  });

  test("an ESRCH pid inside the incomplete grace is kept while its heartbeat is current", async () => {
    const { cacheRoot, clock } = await setup();
    const owner = await acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-a", {
      pid: 1,
      leaseTtlMs: 1_000,
      isProcessAlive: () => true,
    }));
    await expect(acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-b", {
      pid: 4243,
      acquireTimeoutMs: 0,
      leaseTtlMs: 1_000,
      isProcessAlive: (pid) => pid !== 1,
    }))).rejects.toThrow(manualRemoval(cacheRoot));
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual(["owner.owner-a"]);
    await owner.release();
  });

  test("a dead lease that carries this process's own pid is reclaimed after expiry", async () => {
    const { cacheRoot } = await setup();
    const lockDir = pluginCacheLockDirectory(cacheRoot);
    await mkdir(lockDir, { mode: 0o700 });
    await writeFile(join(lockDir, "owner.previous-incarnation"), `${JSON.stringify({
      ownerToken: "previous-incarnation",
      pid: process.pid,
      heartbeatAtMs: Date.now() - 10 * PLUGIN_CACHE_LOCK_LEASE_TTL_MS,
    })}\n`, { mode: 0o600 });
    const lock = await acquirePluginCacheLock(cacheRoot, {
      createOwnerToken: () => "restarted",
      acquireTimeoutMs: 300,
      pollIntervalMs: 20,
    });
    expect(lock.ownerToken).toBe("restarted");
    await expect(readdir(lockDir)).resolves.toEqual(["owner.restarted"]);
    await lock.release();
  });

  test("a held same-process token with an expired heartbeat is not reclaimed", async () => {
    const { cacheRoot, clock } = await setup();
    const owner = await acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-a", {
      pid: process.pid,
      leaseTtlMs: 1_000,
      isProcessAlive: () => true,
    }));
    clock.advance(5_000);
    await expect(acquirePluginCacheLock(cacheRoot, clockedOwner(clock, "owner-b", {
      acquireTimeoutMs: 0,
      leaseTtlMs: 1_000,
      isProcessAlive: () => false,
    }))).rejects.toThrow(manualRemoval(cacheRoot));
    await expect(readdir(pluginCacheLockDirectory(cacheRoot))).resolves.toEqual(["owner.owner-a"]);
    await owner.release();
  });
});

function manualRemoval(cacheRoot: string): RegExp {
  const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `timed out waiting for plugin cache lock: ${escaped(cacheRoot)}[\\s\\S]*${escaped(pluginCacheLockDirectory(cacheRoot))}[\\s\\S]*remove it manually if the owner is gone`,
    "u",
  );
}

function clockedOwner(
  clock: FakeClock,
  token: string,
  overrides: PluginCacheLockHooks = {},
): PluginCacheLockHooks {
  return {
    nowMs: clock.nowMs,
    sleep: async () => {},
    createOwnerToken: () => token,
    acquireTimeoutMs: 50,
    pollIntervalMs: 0,
    ...overrides,
  };
}

function liveOwner(
  clock: FakeClock,
  token: string,
  overrides: PluginCacheLockHooks = {},
): PluginCacheLockHooks {
  return trackedOwner(clock, token, new Set([token]), overrides);
}

function trackedOwner(
  clock: FakeClock,
  token: string,
  liveTokens: Set<string>,
  overrides: PluginCacheLockHooks = {},
): PluginCacheLockHooks {
  return {
    nowMs: clock.nowMs,
    sleep: async () => {},
    createOwnerToken: () => token,
    pid: tokenPid(token),
    isProcessAlive: (pid) => liveTokens.has(tokenForPid(pid)),
    acquireTimeoutMs: 50,
    leaseTtlMs: PLUGIN_CACHE_LOCK_LEASE_TTL_MS,
    pollIntervalMs: 0,
    ...overrides,
  };
}

function tokenPid(token: string): number {
  return 1_000 + [...token].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function tokenForPid(pid: number): string {
  for (const token of ["owner-a", "owner-b", "owner-c", "wrapper"]) {
    if (tokenPid(token) === pid) return token;
  }
  return `unknown:${pid}`;
}

interface FakeClock {
  nowMs: () => number;
  advance: (ms: number) => void;
}

async function setup(): Promise<{ cacheRoot: string; clock: FakeClock; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "agenc-plugin-cache-lock-"));
  roots.push(root);
  const cacheRoot = join(root, "cache", "source");
  await mkdir(join(root, "cache"), { recursive: true, mode: 0o700 });
  let now = Date.now();
  return {
    root,
    cacheRoot,
    clock: {
      nowMs: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    },
  };
}

function waitForChildReady(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child lock holder did not become ready")), 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`child lock holder exited before ready: ${code ?? signal}`));
    });
    child.stdout?.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
}
