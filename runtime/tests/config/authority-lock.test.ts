import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  acquireConfigAuthorityLocks,
  runWithConfigAuthorityLockSync,
  runWithConfigAuthorityLocks,
} from "../../src/config/authority-lock.js";
import { holdLockElsewhere } from "../helpers/foreign-lock-holder.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agenc-authority-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

function replaceLockDirectoryWithFile(target: string): void {
  const lockPath = `${target}.agenc-config-authority.lock`;
  rmSync(lockPath, { recursive: true, force: true });
  writeFileSync(lockPath, "replacement", { flag: "wx" });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("configuration authority lock outcomes", () => {
  test("keeps a completed synchronous result separate from release failure", () => {
    const target = join(temporaryDirectory(), "state.json");

    const outcome = runWithConfigAuthorityLockSync(target, () => {
      writeFileSync(target, "committed", { flag: "wx" });
      replaceLockDirectoryWithFile(target);
      return 41;
    });

    expect(outcome).toMatchObject({
      status: "succeeded",
      value: 41,
      postOperationReleaseErrors: [expect.objectContaining({ code: "ENOTDIR" })],
    });
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("committed");
  });

  test("preserves the exact operation failure when release also fails", () => {
    const target = join(temporaryDirectory(), "state.json");
    const primary = new Error("primary operation failure") as Error & {
      postOperationReleaseErrors?: readonly Error[];
    };

    const outcome = runWithConfigAuthorityLockSync(target, () => {
      replaceLockDirectoryWithFile(target);
      throw primary;
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("expected failure outcome");
    expect(outcome.error).toBe(primary);
    expect(outcome.postOperationReleaseErrors).toEqual([
      expect.objectContaining({ code: "ENOTDIR" }),
    ]);
    expect(primary.postOperationReleaseErrors).toEqual([
      expect.objectContaining({ code: "ENOTDIR" }),
    ]);
  });

  test("returns asynchronous release diagnostics without throwing", async () => {
    const target = join(temporaryDirectory(), "state.json");
    const release = await acquireConfigAuthorityLocks([target]);
    replaceLockDirectoryWithFile(target);

    await expect(release()).resolves.toEqual({
      postOperationReleaseErrors: [
        expect.objectContaining({ code: "ENOTDIR" }),
      ],
    });
  });

  test("keeps a completed asynchronous result separate from release failure", async () => {
    const target = join(temporaryDirectory(), "state.json");
    const value = Object.freeze({ committed: true });

    const outcome = await runWithConfigAuthorityLocks([target], async () => {
      writeFileSync(target, "committed", { flag: "wx" });
      replaceLockDirectoryWithFile(target);
      return value;
    });

    expect(outcome).toMatchObject({
      status: "succeeded",
      value,
      postOperationReleaseErrors: [expect.objectContaining({ code: "ENOTDIR" })],
    });
    if (outcome.status !== "succeeded") {
      throw new Error("expected successful operation outcome");
    }
    expect(outcome.value).toBe(value);
  });

  test("preserves the exact asynchronous operation failure", async () => {
    const target = join(temporaryDirectory(), "state.json");
    const primary = new Error("primary async operation failure") as Error & {
      postOperationReleaseErrors?: readonly Error[];
    };

    const outcome = await runWithConfigAuthorityLocks([target], async () => {
      replaceLockDirectoryWithFile(target);
      throw primary;
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("expected failure outcome");
    expect(outcome.error).toBe(primary);
    expect(outcome.postOperationReleaseErrors).toEqual([
      expect.objectContaining({ code: "ENOTDIR" }),
    ]);
    expect(primary.postOperationReleaseErrors).toEqual([
      expect.objectContaining({ code: "ENOTDIR" }),
    ]);
  });
});

describe("synchronous configuration authority acquisition", () => {
  test("waits for a holder outside this thread instead of failing with ELOCKED", async () => {
    const target = join(temporaryDirectory(), "state.json");
    const lockPath = `${target}.agenc-config-authority.lock`;
    const holder = await holdLockElsewhere(lockPath, 300);
    expect(existsSync(lockPath)).toBe(true);

    const outcome = runWithConfigAuthorityLockSync(target, () => 7);

    expect(outcome).toMatchObject({ status: "succeeded", value: 7 });
    await holder.released;
  });

  test("gives up with the ELOCKED error once the wait budget runs out", () => {
    const target = join(temporaryDirectory(), "state.json");
    mkdirSync(`${target}.agenc-config-authority.lock`);
    let operationRan = false;
    const startedAt = Date.now();

    expect(() =>
      runWithConfigAuthorityLockSync(
        target,
        () => {
          operationRan = true;
        },
        { waitMs: 150 },
      ),
    ).toThrow(expect.objectContaining({ code: "ELOCKED" }));
    const waited = Date.now() - startedAt;
    expect(waited).toBeGreaterThanOrEqual(140);
    expect(waited).toBeLessThan(1_500);
    expect(operationRan).toBe(false);
  });

  test("fails at once when this process holds the lock asynchronously", async () => {
    const target = join(temporaryDirectory(), "state.json");
    const release = await acquireConfigAuthorityLocks([target]);
    try {
      const startedAt = Date.now();
      expect(() => runWithConfigAuthorityLockSync(target, () => 1)).toThrow(
        expect.objectContaining({ code: "ELOCKED" }),
      );
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      await release();
    }
    expect(runWithConfigAuthorityLockSync(target, () => 2)).toMatchObject({
      status: "succeeded",
      value: 2,
    });
  });

  test("fails a nested acquisition at once instead of waiting on itself", () => {
    const target = join(temporaryDirectory(), "state.json");
    const startedAt = Date.now();

    const outer = runWithConfigAuthorityLockSync(target, () =>
      runWithConfigAuthorityLockSync(target, () => "inner"),
    );

    expect(outer.status).toBe("failed");
    if (outer.status !== "failed") throw new Error("expected failure outcome");
    expect(outer.error).toMatchObject({ code: "ELOCKED" });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(runWithConfigAuthorityLockSync(target, () => 3)).toMatchObject({
      status: "succeeded",
      value: 3,
    });
  });
});
