import { afterEach, describe, expect, test } from "vitest";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FsLockTimeoutError,
  lockfilePathFor,
  withFsLock,
} from "./fs-lock.js";
import {
  _clearMemoryWriteLocksForTest,
  getMemoryWriteLock,
} from "./loader.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  _clearMemoryWriteLocksForTest();
});

async function makeTempFile(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "agenc-fs-lock-"));
  return join(tempDir, "target.md");
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("withFsLock", () => {
  test("happy path: acquire -> run -> release", async () => {
    const target = await makeTempFile();
    const lockPath = lockfilePathFor(target);

    let sawLockInsideFn = false;
    const result = await withFsLock(target, async () => {
      sawLockInsideFn = await exists(lockPath);
      return 42;
    });

    expect(result).toBe(42);
    expect(sawLockInsideFn).toBe(true);
    // Released after fn resolves.
    expect(await exists(lockPath)).toBe(false);
  });

  test("two concurrent withFsLock calls against the same path serialize", async () => {
    const target = await makeTempFile();
    const order: string[] = [];
    const slow = withFsLock(
      target,
      async () => {
        order.push("slow-start");
        await new Promise((r) => setTimeout(r, 40));
        order.push("slow-end");
      },
      { retryMs: 5, timeoutMs: 5_000 },
    );
    // Yield once so `slow` acquires first.
    await new Promise((r) => setImmediate(r));
    const fast = withFsLock(
      target,
      async () => {
        order.push("fast-start");
        order.push("fast-end");
      },
      { retryMs: 5, timeoutMs: 5_000 },
    );
    await Promise.all([slow, fast]);

    expect(order).toEqual([
      "slow-start",
      "slow-end",
      "fast-start",
      "fast-end",
    ]);
  });

  test("stale lockfile (>60s old) is force-broken and acquired", async () => {
    const target = await makeTempFile();
    const lockPath = lockfilePathFor(target);
    // Plant a stale lockfile: ts 90s in the past.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999, ts: Date.now() - 90_000 }),
      "utf8",
    );

    const result = await withFsLock(
      target,
      async () => {
        // Once acquired we own the sibling lockfile.
        expect(await exists(lockPath)).toBe(true);
        return "ok";
      },
      { retryMs: 5, timeoutMs: 500 },
    );
    expect(result).toBe("ok");
    // Released on fn exit.
    expect(await exists(lockPath)).toBe(false);
  });

  test("fresh lockfile (<60s old) blocks acquisition until timeout", async () => {
    const target = await makeTempFile();
    const lockPath = lockfilePathFor(target);
    // Plant a fresh lockfile: ts right now.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999, ts: Date.now() }),
      "utf8",
    );

    const start = Date.now();
    await expect(
      withFsLock(target, async () => "never", {
        retryMs: 20,
        timeoutMs: 200,
      }),
    ).rejects.toBeInstanceOf(FsLockTimeoutError);
    const elapsed = Date.now() - start;
    // Allow a small window for jitter either way.
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1_500);

    // Lockfile is left alone (we never owned it).
    expect(await exists(lockPath)).toBe(true);
    const payload = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
    };
    expect(payload.pid).toBe(999_999);
  });

  test("ENOENT on unlink is race-safe (fn still returns)", async () => {
    const target = await makeTempFile();
    const lockPath = lockfilePathFor(target);
    const { unlink } = await import("node:fs/promises");

    const result = await withFsLock(target, async () => {
      // Simulate another process (e.g. a stale-breaker) cleaning up our
      // lockfile mid-flight. Release must not throw.
      expect(await exists(lockPath)).toBe(true);
      await unlink(lockPath);
      return "released-by-other";
    });

    expect(result).toBe("released-by-other");
    expect(await exists(lockPath)).toBe(false);
  });

  test("writes a parseable pid+ts payload into the lockfile", async () => {
    const target = await makeTempFile();
    const lockPath = lockfilePathFor(target);

    await withFsLock(target, async () => {
      const raw = await readFile(lockPath, "utf8");
      const obj = JSON.parse(raw) as { pid?: unknown; ts?: unknown };
      expect(typeof obj.pid).toBe("number");
      expect(obj.pid).toBe(process.pid);
      expect(typeof obj.ts).toBe("number");
      expect((obj.ts as number) - Date.now()).toBeLessThan(5_000);
      // The lockfile file mode itself isn't load-bearing, just sanity
      // check it is a regular file.
      const s = await stat(lockPath);
      expect(s.isFile()).toBe(true);
    });
  });
});

describe("getMemoryWriteLock (composed AsyncLock + fs lock)", () => {
  test("serializes writers in-process AND writes the fs lockfile", async () => {
    const target = await makeTempFile();
    const lockPath = lockfilePathFor(target);
    const lock = getMemoryWriteLock(target);

    const order: string[] = [];
    let lockfileSeenDuringFirst = false;

    const first = lock.with(async () => {
      order.push("first-start");
      // The sibling lockfile must exist while the critical section runs.
      lockfileSeenDuringFirst = await exists(lockPath);
      await new Promise((r) => setTimeout(r, 20));
      order.push("first-end");
    });
    // Yield; second call must queue behind first on the AsyncLock.
    await new Promise((r) => setImmediate(r));
    const second = lock.with(async () => {
      order.push("second-start");
      order.push("second-end");
    });
    await Promise.all([first, second]);

    expect(lockfileSeenDuringFirst).toBe(true);
    expect(order).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);
    expect(await exists(lockPath)).toBe(false);
  });

  test("same lock instance returned for equivalent-but-differently-spelled paths", () => {
    _clearMemoryWriteLocksForTest();
    const target = "/tmp/memdir-composed/x.md";
    const a = getMemoryWriteLock(target);
    const b = getMemoryWriteLock("/tmp/memdir-composed/../memdir-composed/x.md");
    expect(b).toBe(a);
  });
});
