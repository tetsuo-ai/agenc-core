import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const unlinkInterleave = vi.hoisted(() => ({
  lockPath: undefined as string | undefined,
  run: undefined as undefined | (() => Promise<void>),
  failPath: undefined as string | undefined,
  failRemaining: 0,
  block: undefined as undefined | Promise<void>,
  entered: undefined as undefined | (() => void),
  inside: 0,
  maxInside: 0,
}));

const opsDirectoryInterleave = vi.hoisted(() => ({
  removeBeforeLstat: undefined as string | undefined,
  failMkdirOnce: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: (async (...args: Parameters<typeof actual.mkdir>) => {
      if (opsDirectoryInterleave.failMkdirOnce === String(args[0])) {
        // Node's recursive mkdir fails ENOENT when the directory it found is
        // removed before its own existence check.
        opsDirectoryInterleave.failMkdirOnce = undefined;
        throw Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${String(args[0])}'`), {
          code: "ENOENT",
        });
      }
      return actual.mkdir(...args);
    }) as typeof actual.mkdir,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      const target = String(args[0]);
      if (opsDirectoryInterleave.removeBeforeLstat === target) {
        // A concurrent install or recovery removes the empty ops directory
        // right after this operation created it.
        opsDirectoryInterleave.removeBeforeLstat = undefined;
        await actual.rmdir(target);
      }
      return actual.lstat(...args);
    }) as typeof actual.lstat,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      const target = String(path);
      if (
        unlinkInterleave.failPath !== undefined
        && target === unlinkInterleave.failPath
        && unlinkInterleave.failRemaining > 0
      ) {
        unlinkInterleave.failRemaining -= 1;
        unlinkInterleave.inside += 1;
        unlinkInterleave.maxInside = Math.max(unlinkInterleave.maxInside, unlinkInterleave.inside);
        const entered = unlinkInterleave.entered;
        unlinkInterleave.entered = undefined;
        entered?.();
        try {
          const block = unlinkInterleave.block;
          unlinkInterleave.block = undefined;
          if (block !== undefined) await block;
        } finally {
          unlinkInterleave.inside -= 1;
        }
        throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
      }
      const run = unlinkInterleave.run;
      if (
        run !== undefined
        && unlinkInterleave.lockPath !== undefined
        && target === unlinkInterleave.lockPath
      ) {
        unlinkInterleave.run = undefined;
        await run();
      }
      return actual.unlink(path);
    },
  };
});

import {
  pluginInstallDirectoryLockDirectory,
  setPluginInstallDirectoryLockGuardStaleMs,
  setPluginInstallDirectoryLockPublishHook,
  setPluginInstallDirectoryLockReclaimHook,
  setPluginInstallDirectoryLockWaitHook,
  tryPluginInstallDirectoryLock,
  withPluginInstallDirectoryLock,
  type PluginInstallDirectoryLockPublishEvent,
  type PluginInstallDirectoryLockReclaimEvent,
} from "../../../src/plugins/cli/plugin-install-directory-lock.js";

function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  if (typeof child.pid !== "number" || child.pid <= 1) {
    throw new Error("could not obtain an exited pid");
  }
  try {
    process.kill(child.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return child.pid;
    throw error;
  }
  throw new Error(`pid ${child.pid} is still live`);
}

async function plantDestination(): Promise<{
  readonly root: string;
  readonly destination: string;
  readonly lockPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "install-dir-lock-"));
  const destination = join(root, "demo");
  await mkdir(destination, { recursive: true });
  const lockPath = await pluginInstallDirectoryLockDirectory(destination);
  return { root, destination, lockPath };
}

async function plantStaleLock(): Promise<{
  readonly root: string;
  readonly destination: string;
  readonly lockPath: string;
  readonly text: string;
}> {
  const world = await plantDestination();
  await mkdir(dirname(world.lockPath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify({
    pid: exitedPid(),
    nonce: randomUUID(),
    acquiredAtMs: Date.now() - 10_000,
  })}\n`;
  await writeFile(world.lockPath, text, { mode: 0o600 });
  return { ...world, text };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

describe("plugin install directory lock reclaim", () => {
  it("keeps a single holder when a stale read resumes after another reclaim enters", async () => {
    const world = await plantStaleLock();
    let inside = 0;
    let maxInside = 0;
    let releaseB: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      releaseB = resolveGate;
    });
    let bEntered: () => void = () => {};
    const bEnteredGate = new Promise<void>((resolveEntered) => {
      bEntered = resolveEntered;
    });
    let bPromise: Promise<void> = Promise.resolve();
    let dEntered = false;
    let dPromise: Promise<void> = Promise.resolve();
    let started = false;
    let bReleaseOnce = false;
    const enter = (): void => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
    };
    const leave = (): void => {
      inside -= 1;
    };
    try {
      setPluginInstallDirectoryLockReclaimHook(async (event: PluginInstallDirectoryLockReclaimEvent) => {
        if (event.phase === "stale-observed") {
          if (started) return;
          started = true;
          bPromise = withPluginInstallDirectoryLock(world.destination, async () => {
            enter();
            bEntered();
            await gate;
            leave();
          });
          await bEnteredGate;
          dPromise = withPluginInstallDirectoryLock(world.destination, async () => {
            enter();
            dEntered = true;
            leave();
          });
          return;
        }
        if (event.phase === "reclaim-settled") {
          if (inside !== 1 || bReleaseOnce) return;
          bReleaseOnce = true;
          releaseB();
          await bPromise;
        }
      });
      const aPromise = withPluginInstallDirectoryLock(world.destination, async () => {
        enter();
        leave();
      });
      await aPromise;
      await bPromise;
      await dPromise;
      expect(dEntered).toBe(true);
      expect(maxInside).toBe(1);
      expect(inside).toBe(0);
    } finally {
      releaseB();
      setPluginInstallDirectoryLockReclaimHook(undefined);
      setPluginInstallDirectoryLockGuardStaleMs(undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("does not take over a dead reclaim guard younger than the bound", async () => {
    const world = await plantStaleLock();
    try {
      setPluginInstallDirectoryLockGuardStaleMs(60_000);
      const guardPath = `${world.lockPath}.reclaim`;
      await writeFile(
        guardPath,
        `${JSON.stringify({ pid: exitedPid(), nonce: randomUUID(), acquiredAtMs: Date.now() })}\n`,
      );
      expect(await tryPluginInstallDirectoryLock(world.destination)).toBeUndefined();
      expect(await readFile(world.lockPath, "utf8")).toBe(world.text);
    } finally {
      setPluginInstallDirectoryLockGuardStaleMs(undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("reclaims a dead guard once it is older than the bound and then the stale lock", async () => {
    const world = await plantStaleLock();
    try {
      setPluginInstallDirectoryLockGuardStaleMs(1);
      const guardPath = `${world.lockPath}.reclaim`;
      await writeFile(
        guardPath,
        `${JSON.stringify({
          pid: exitedPid(),
          nonce: randomUUID(),
          acquiredAtMs: Date.now() - 10_000,
        })}\n`,
      );
      let entered = false;
      await withPluginInstallDirectoryLock(world.destination, async () => {
        entered = true;
        expect(await readFile(world.lockPath, "utf8")).not.toBe(world.text);
      });
      expect(entered).toBe(true);
      await expect(lstat(guardPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      setPluginInstallDirectoryLockGuardStaleMs(undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("leaves a partial lock file in place", async () => {
    const world = await plantDestination();
    try {
      await mkdir(dirname(world.lockPath), { recursive: true, mode: 0o700 });
      await writeFile(world.lockPath, "partial\n");
      await expect(tryPluginInstallDirectoryLock(world.destination)).rejects.toThrow(
        `plugin install directory lock requires manual recovery: ${world.lockPath}`,
      );
      expect(await readFile(world.lockPath, "utf8")).toBe("partial\n");
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("does not replace an empty or partial lock planted before publish", async () => {
    const world = await plantDestination();
    let planted = false;
    try {
      setPluginInstallDirectoryLockPublishHook(async (event: PluginInstallDirectoryLockPublishEvent) => {
        if (event.phase !== "staging-ready" || planted) return;
        planted = true;
        await mkdir(event.lockDir, { mode: 0o700 }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
      });
      await expect(tryPluginInstallDirectoryLock(world.destination)).rejects.toThrow(
        `plugin install directory lock requires manual recovery: ${world.lockPath}`,
      );
      expect(planted).toBe(true);
      expect(await readdir(world.lockPath)).toEqual([]);
    } finally {
      setPluginInstallDirectoryLockPublishHook(undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("keeps a single holder when a second acquire runs during publish", async () => {
    const world = await plantDestination();
    let inside = 0;
    let maxInside = 0;
    let releaseSecond: () => void = () => {};
    const secondGate = new Promise<void>((resolveGate) => {
      releaseSecond = resolveGate;
    });
    let markSecondIn: () => void = () => {};
    const secondIn = new Promise<void>((resolveIn) => {
      markSecondIn = resolveIn;
    });
    let markBlocked: () => void = () => {};
    const blocked = new Promise<void>((resolveBlocked) => {
      markBlocked = resolveBlocked;
    });
    let secondPromise: Promise<void> = Promise.resolve();
    let started = false;
    let publisherEntered = false;
    let secondEntered = false;
    const enter = (): void => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
    };
    const leave = (): void => {
      inside -= 1;
    };
    try {
      setPluginInstallDirectoryLockWaitHook(() => {
        markBlocked();
      });
      setPluginInstallDirectoryLockPublishHook(async (event: PluginInstallDirectoryLockPublishEvent) => {
        if (event.phase !== "staging-ready" || started) return;
        started = true;
        secondPromise = withPluginInstallDirectoryLock(world.destination, async () => {
          enter();
          secondEntered = true;
          markSecondIn();
          await secondGate;
          leave();
        });
        const status = await Promise.race([
          secondIn.then(() => "entered" as const),
          blocked.then(() => "blocked" as const),
          delay(2_000).then(() => "timeout" as const),
        ]);
        if (status === "entered") {
          setTimeout(() => {
            if (!publisherEntered) releaseSecond();
          }, 1_000);
        }
      });
      const publisher = withPluginInstallDirectoryLock(world.destination, async () => {
        publisherEntered = true;
        enter();
        await delay(50);
        leave();
        releaseSecond();
      });
      await publisher;
      await secondPromise;
      expect(started).toBe(true);
      expect(publisherEntered).toBe(true);
      expect(secondEntered).toBe(true);
      expect(maxInside).toBe(1);
      expect(inside).toBe(0);
    } finally {
      releaseSecond();
      setPluginInstallDirectoryLockPublishHook(undefined);
      setPluginInstallDirectoryLockWaitHook(undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("does not drop the nonce before its own lock is gone", async () => {
    const world = await plantDestination();
    let inside = 0;
    let maxInside = 0;
    let releaseWaiter: () => void = () => {};
    const waiterGate = new Promise<void>((resolveGate) => {
      releaseWaiter = resolveGate;
    });
    let markWaiterIn: () => void = () => {};
    const waiterIn = new Promise<void>((resolveIn) => {
      markWaiterIn = resolveIn;
    });
    let markBlocked: () => void = () => {};
    const blocked = new Promise<void>((resolveBlocked) => {
      markBlocked = resolveBlocked;
    });
    let waiterPromise: Promise<void> = Promise.resolve();
    let thirdPromise: Promise<void> = Promise.resolve();
    let started = false;
    let thirdEntered = false;
    let thirdStarted = false;
    let trackWaiter = false;
    const enter = (): void => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
    };
    const leave = (): void => {
      inside -= 1;
    };
    try {
      setPluginInstallDirectoryLockWaitHook(() => {
        if (trackWaiter) markBlocked();
      });
      setPluginInstallDirectoryLockPublishHook(async (event: PluginInstallDirectoryLockPublishEvent) => {
        if (event.phase !== "before-release-remove" || started) return;
        started = true;
        trackWaiter = true;
        waiterPromise = withPluginInstallDirectoryLock(world.destination, async () => {
          enter();
          markWaiterIn();
          await waiterGate;
          leave();
        });
        const status = await Promise.race([
          waiterIn.then(() => "entered" as const),
          blocked.then(() => "blocked" as const),
          delay(2_000).then(() => "timeout" as const),
        ]);
        trackWaiter = false;
        if (status === "entered") {
          thirdStarted = true;
          thirdPromise = withPluginInstallDirectoryLock(world.destination, async () => {
            enter();
            thirdEntered = true;
            leave();
          });
          await delay(50);
        }
      });
      await withPluginInstallDirectoryLock(world.destination, async () => {
        enter();
        leave();
      });
      if (!thirdStarted) {
        thirdStarted = true;
        thirdPromise = withPluginInstallDirectoryLock(world.destination, async () => {
          enter();
          thirdEntered = true;
          leave();
        });
      }
      await Promise.race([
        waiterIn.then(() => delay(100)),
        delay(400),
      ]);
      expect(started).toBe(true);
      expect(maxInside).toBe(1);
      releaseWaiter();
      await Promise.all([waiterPromise, thirdPromise]);
      expect(thirdEntered).toBe(true);
      expect(maxInside).toBe(1);
      expect(inside).toBe(0);
    } finally {
      releaseWaiter();
      setPluginInstallDirectoryLockPublishHook(undefined);
      setPluginInstallDirectoryLockWaitHook(undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("keeps a single holder when a symlink is replaced before unlink", async () => {
    const world = await plantDestination();
    await mkdir(dirname(world.lockPath), { recursive: true, mode: 0o700 });
    const target = join(world.root, "elsewhere");
    await writeFile(target, "not-a-lock\n");
    await symlink(target, world.lockPath);
    let inside = 0;
    let maxInside = 0;
    let releaseSecond: () => void = () => {};
    const secondGate = new Promise<void>((resolveGate) => {
      releaseSecond = resolveGate;
    });
    let markSecondIn: () => void = () => {};
    const secondIn = new Promise<void>((resolveIn) => {
      markSecondIn = resolveIn;
    });
    let markBlocked: () => void = () => {};
    const blocked = new Promise<void>((resolveBlocked) => {
      markBlocked = resolveBlocked;
    });
    let secondPromise: Promise<void> = Promise.resolve();
    let started = false;
    let publisherEntered = false;
    let secondEntered = false;
    const enter = (): void => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
    };
    const leave = (): void => {
      inside -= 1;
    };
    const replaceAndHold = async (): Promise<void> => {
      if (started) return;
      started = true;
      unlinkInterleave.run = undefined;
      await rm(world.lockPath);
      secondPromise = withPluginInstallDirectoryLock(world.destination, async () => {
        enter();
        secondEntered = true;
        markSecondIn();
        await secondGate;
        leave();
      });
      const status = await Promise.race([
        secondIn.then(() => "entered" as const),
        blocked.then(() => "blocked" as const),
        delay(2_000).then(() => "timeout" as const),
      ]);
      if (status === "entered") {
        setTimeout(() => {
          if (!publisherEntered) releaseSecond();
        }, 1_000);
      }
    };
    try {
      setPluginInstallDirectoryLockWaitHook(() => {
        markBlocked();
      });
      setPluginInstallDirectoryLockReclaimHook(async (event: PluginInstallDirectoryLockReclaimEvent) => {
        if (event.phase !== "stale-observed") return;
        await replaceAndHold();
      });
      unlinkInterleave.lockPath = world.lockPath;
      unlinkInterleave.run = replaceAndHold;
      const publisher = withPluginInstallDirectoryLock(world.destination, async () => {
        publisherEntered = true;
        enter();
        await delay(50);
        leave();
        releaseSecond();
      });
      await publisher;
      await secondPromise;
      expect(started).toBe(true);
      expect(publisherEntered).toBe(true);
      expect(secondEntered).toBe(true);
      expect(maxInside).toBe(1);
      expect(inside).toBe(0);
    } finally {
      releaseSecond();
      unlinkInterleave.run = undefined;
      unlinkInterleave.lockPath = undefined;
      setPluginInstallDirectoryLockReclaimHook(undefined);
      setPluginInstallDirectoryLockWaitHook(undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("does not expire a live owner because the record is old", async () => {
    const world = await plantDestination();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      expect(child.pid).toEqual(expect.any(Number));
      setPluginInstallDirectoryLockGuardStaleMs(0);
      await mkdir(dirname(world.lockPath), { recursive: true, mode: 0o700 });
      const text = `${JSON.stringify({ pid: child.pid, nonce: randomUUID(), acquiredAtMs: 1 })}\n`;
      await writeFile(world.lockPath, text, { mode: 0o600 });
      expect(await tryPluginInstallDirectoryLock(world.destination)).toBeUndefined();
      expect(await readFile(world.lockPath, "utf8")).toBe(text);
    } finally {
      child.kill();
      setPluginInstallDirectoryLockGuardStaleMs(undefined);
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("reports unknown lock and reclaim entries and leaves them in place", async () => {
    const worlds: { readonly root: string }[] = [];
    try {
      setPluginInstallDirectoryLockGuardStaleMs(0);
      const past = new Date(Date.now() - 120_000);
      for (const where of ["lock", "reclaim"] as const) {
        for (const kind of ["empty", "partial", "symlink", "directory", "fifo"] as const) {
          const world = await plantDestination();
          worlds.push(world);
          await mkdir(dirname(world.lockPath), { recursive: true, mode: 0o700 });
          if (where === "reclaim") {
            const text = `${JSON.stringify({
              pid: exitedPid(),
              nonce: randomUUID(),
              acquiredAtMs: Date.now() - 10_000,
            })}\n`;
            await writeFile(world.lockPath, text, { mode: 0o600 });
          }
          const target = where === "lock" ? world.lockPath : `${world.lockPath}.reclaim`;
          await plantUnknown(world.root, target, kind);
          if (kind !== "symlink") await utimes(target, past, past).catch(() => undefined);
          await expect(tryPluginInstallDirectoryLock(world.destination)).rejects.toThrow(
            `plugin install directory lock requires manual recovery: ${target}`,
          );
          expect(await unknownRemains(target, kind)).toBe(true);
          if (where === "reclaim") {
            expect((await readFile(world.lockPath, "utf8")).includes("\"pid\"")).toBe(true);
          }
        }
      }
    } finally {
      setPluginInstallDirectoryLockGuardStaleMs(undefined);
      await Promise.all(worlds.map((world) => rm(world.root, { recursive: true, force: true })));
    }
  });

  it("does not poll forever when the reclaim guard is a directory", async () => {
    const world = await plantStaleLock();
    const guard = `${world.lockPath}.reclaim`;
    await mkdir(guard);
    await writeFile(join(guard, "keep.txt"), "stay\n");
    let entered = false;
    const acquisition = withPluginInstallDirectoryLock(world.destination, async () => {
      entered = true;
    }).then(
      () => "entered" as const,
      (error: unknown) => error,
    );
    try {
      const result = await Promise.race([
        acquisition,
        delay(1_000).then(() => "pending" as const),
      ]);
      expect(result).not.toBe("pending");
      expect(result).not.toBe("entered");
      expect(entered).toBe(false);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe(
        `plugin install directory lock requires manual recovery: ${guard}`,
      );
      expect(await readFile(join(guard, "keep.txt"), "utf8")).toBe("stay\n");
      expect(await readFile(world.lockPath, "utf8")).toBe(world.text);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("retries release after one failed unlink and then lets a new acquire in", async () => {
    const world = await plantDestination();
    const hold = await tryPluginInstallDirectoryLock(world.destination);
    expect(hold).toBeDefined();
    try {
      unlinkInterleave.failPath = world.lockPath;
      unlinkInterleave.failRemaining = 1;
      unlinkInterleave.maxInside = 0;
      await expect(hold!.release()).rejects.toMatchObject({ code: "EACCES" });
      expect(await readFile(world.lockPath, "utf8")).toContain(`"pid":${process.pid}`);
      expect(await tryPluginInstallDirectoryLock(world.destination)).toBeUndefined();
      await hold!.release();
      await expect(lstat(world.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      const again = await tryPluginInstallDirectoryLock(world.destination);
      expect(again).toBeDefined();
      await again!.release();
    } finally {
      unlinkInterleave.failPath = undefined;
      unlinkInterleave.failRemaining = 0;
      unlinkInterleave.block = undefined;
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("serializes overlapping release attempts and the later one removes the lock", async () => {
    const world = await plantDestination();
    const hold = await tryPluginInstallDirectoryLock(world.destination);
    expect(hold).toBeDefined();
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    try {
      unlinkInterleave.failPath = world.lockPath;
      unlinkInterleave.failRemaining = 1;
      unlinkInterleave.block = firstGate;
      unlinkInterleave.inside = 0;
      unlinkInterleave.maxInside = 0;
      let markEntered: () => void = () => {};
      const enteredGate = new Promise<void>((resolveEntered) => {
        markEntered = resolveEntered;
      });
      unlinkInterleave.entered = markEntered;
      const first = hold!.release();
      await enteredGate;
      expect(unlinkInterleave.maxInside).toBe(1);
      let secondSettled = false;
      const second = hold!.release().finally(() => {
        secondSettled = true;
      });
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(secondSettled).toBe(false);
      expect(unlinkInterleave.maxInside).toBe(1);
      releaseFirst();
      await expect(first).rejects.toMatchObject({ code: "EACCES" });
      await second;
      expect(secondSettled).toBe(true);
      expect(unlinkInterleave.maxInside).toBe(1);
      await expect(lstat(world.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseFirst();
      unlinkInterleave.failPath = undefined;
      unlinkInterleave.failRemaining = 0;
      unlinkInterleave.block = undefined;
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("reports a completed body when lock cleanup keeps failing", async () => {
    const world = await plantDestination();
    try {
      unlinkInterleave.failPath = world.lockPath;
      unlinkInterleave.failRemaining = 5;
      await expect(withPluginInstallDirectoryLock(world.destination, async () => "done")).rejects.toThrow(
        "plugin install directory lock cleanup failed after the locked operation completed: injected EACCES",
      );
      expect(await readFile(world.lockPath, "utf8")).toContain(`"pid":${process.pid}`);
      expect(await tryPluginInstallDirectoryLock(world.destination)).toBeUndefined();
    } finally {
      unlinkInterleave.failPath = undefined;
      unlinkInterleave.failRemaining = 0;
      await rm(world.root, { recursive: true, force: true });
    }
  });

  it("keeps the body error when lock cleanup also fails", async () => {
    const world = await plantDestination();
    const bodyError = new Error("body failed for lock release");
    try {
      unlinkInterleave.failPath = world.lockPath;
      unlinkInterleave.failRemaining = 5;
      await expect(withPluginInstallDirectoryLock(world.destination, async () => {
        throw bodyError;
      })).rejects.toBe(bodyError);
      expect(await readFile(world.lockPath, "utf8")).toContain(`"pid":${process.pid}`);
    } finally {
      unlinkInterleave.failPath = undefined;
      unlinkInterleave.failRemaining = 0;
      await rm(world.root, { recursive: true, force: true });
    }
  });
});

function makeFifo(path: string): void {
  const result = spawnSync("mkfifo", [path], { stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`mkfifo failed: ${result.stderr.toString()}`);
  }
}

async function plantUnknown(root: string, target: string, kind: "empty" | "partial" | "symlink" | "directory" | "fifo"): Promise<void> {
  switch (kind) {
    case "empty":
      await writeFile(target, "");
      return;
    case "partial":
      await writeFile(target, "partial\n");
      return;
    case "symlink": {
      const elsewhere = join(root, `elsewhere-${randomUUID()}`);
      await writeFile(elsewhere, "not-a-lock\n");
      await symlink(elsewhere, target);
      return;
    }
    case "directory":
      await mkdir(target);
      await writeFile(join(target, "keep.txt"), "stay\n");
      return;
    case "fifo":
      makeFifo(target);
      return;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled unknown lock entry: ${String(exhaustive)}`);
    }
  }
}

async function unknownRemains(target: string, kind: "empty" | "partial" | "symlink" | "directory" | "fifo"): Promise<boolean> {
  const info = await lstat(target);
  switch (kind) {
    case "empty":
      return info.isFile() && await readFile(target, "utf8") === "";
    case "partial":
      return info.isFile() && await readFile(target, "utf8") === "partial\n";
    case "symlink":
      return info.isSymbolicLink();
    case "directory":
      return info.isDirectory() && await readFile(join(target, "keep.txt"), "utf8") === "stay\n";
    case "fifo":
      return info.isFIFO();
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled unknown lock entry: ${String(exhaustive)}`);
    }
  }
}

describe("plugin install directory lock setup", () => {
  it("recreates the ops directory when a concurrent cleanup removes it before the lock is published", async () => {
    const root = await mkdtemp(join(tmpdir(), "install-dir-lock-ops-"));
    try {
      const destination = join(root, "demo");
      const opsDir = dirname(await pluginInstallDirectoryLockDirectory(destination));
      opsDirectoryInterleave.removeBeforeLstat = opsDir;
      await expect(
        withPluginInstallDirectoryLock(destination, async () => "locked body ran"),
      ).resolves.toBe("locked body ran");
      expect(opsDirectoryInterleave.removeBeforeLstat).toBeUndefined();
    } finally {
      opsDirectoryInterleave.removeBeforeLstat = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries when the recursive mkdir of the ops directory fails ENOENT during a concurrent cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "install-dir-lock-ops-"));
    try {
      const destination = join(root, "demo");
      const opsDir = dirname(await pluginInstallDirectoryLockDirectory(destination));
      opsDirectoryInterleave.failMkdirOnce = opsDir;
      await expect(
        withPluginInstallDirectoryLock(destination, async () => "locked body ran"),
      ).resolves.toBe("locked body ran");
      expect(opsDirectoryInterleave.failMkdirOnce).toBeUndefined();
    } finally {
      opsDirectoryInterleave.failMkdirOnce = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });
});
