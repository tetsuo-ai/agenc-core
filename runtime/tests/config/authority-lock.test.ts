import {
  existsSync,
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
