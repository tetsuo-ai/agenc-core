const lockRemoval = vi.hoisted(() => ({ path: "", beforeRemove: undefined as undefined | (() => void) }));
const lockStamp = vi.hoisted(() => ({ path: "", beforeWrite: undefined as undefined | ((write: () => void) => boolean | void) }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, writeFileSync: ((path: Parameters<typeof fs.writeFileSync>[0], data: Parameters<typeof fs.writeFileSync>[1], options?: Parameters<typeof fs.writeFileSync>[2]) => {
    const write = () => fs.writeFileSync(path, data, options);
    if (String(path) === lockStamp.path && lockStamp.beforeWrite) {
      const callback = lockStamp.beforeWrite;
      lockStamp.beforeWrite = undefined;
      if (callback(write)) return;
    }
    return write();
  }) as typeof fs.writeFileSync, rmSync: ((path: Parameters<typeof fs.rmSync>[0], options?: Parameters<typeof fs.rmSync>[1]) => {
    if (String(path) === lockRemoval.path && lockRemoval.beforeRemove) {
      const callback = lockRemoval.beforeRemove;
      lockRemoval.beforeRemove = undefined;
      callback();
    }
    return fs.rmSync(path, options);
  }) as typeof fs.rmSync };
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadRegistryLock } from "../../src/thread-store/registry-lock.js";

const deadPid = 2_147_483_647;
const dirs: string[] = [];

afterEach(() => {
  lockRemoval.path = "";
  lockRemoval.beforeRemove = undefined;
  lockStamp.path = "";
  lockStamp.beforeWrite = undefined;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("keeps one owner when stamping falls between a stale check and removal", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-stamp-reclaim-"));
  dirs.push(dir);
  const initializing = new ThreadRegistryLock(dir);
  const reclaimer = new ThreadRegistryLock(dir);
  const third = new ThreadRegistryLock(dir);
  let initializingStamp: (() => void) | undefined;
  let stampedBeforeRemoval = false;
  let reclaimerAcquired = false;
  lockStamp.path = join(initializing.path, "holder.pid");
  lockStamp.beforeWrite = (write) => {
    initializingStamp = write;
    // A has created the directory, then pauses past the stale threshold.
    const staleTime = new Date(Date.now() - 6_000);
    utimesSync(initializing.path, staleTime, staleTime);
    reclaimerAcquired = reclaimer.tryAcquire();
    return stampedBeforeRemoval;
  };
  lockRemoval.path = initializing.path;
  lockRemoval.beforeRemove = () => {
    // B finished its final stale check. A stamps before B removes the path.
    initializingStamp!();
    stampedBeforeRemoval = true;
  };

  try {
    const initializingAcquired = initializing.tryAcquire();
    lockRemoval.beforeRemove = undefined;
    expect(Number(initializingAcquired) + Number(reclaimerAcquired)).toBe(1);
    expect(third.tryAcquire()).toBe(false);
  } finally {
    lockRemoval.beforeRemove = undefined;
    third.release();
    initializing.release();
    reclaimer.release();
  }
});

it("refuses a reclaimer while an unstamped acquisition pauses", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-initialization-"));
  dirs.push(dir);
  const stalled = new ThreadRegistryLock(dir);
  const replacement = new ThreadRegistryLock(dir);
  const third = new ThreadRegistryLock(dir);
  let replacementAcquired = false;
  let stalledAcquired = false;
  let stalledError: unknown;
  lockStamp.path = join(stalled.path, "holder.pid");
  lockStamp.beforeWrite = () => {
    const staleTime = new Date(Date.now() - 6_000);
    utimesSync(stalled.path, staleTime, staleTime);
    replacementAcquired = replacement.tryAcquire();
  };
  try {
    try { stalledAcquired = stalled.tryAcquire(); }
    catch (error) { stalledError = error; }

    expect(replacementAcquired).toBe(false);
    expect(existsSync(stalled.path)).toBe(true);
    expect(readFileSync(join(stalled.path, "holder.pid"), "utf8")).toMatch(/^\d+:[0-9a-f-]+$/u);
    expect(third.tryAcquire()).toBe(false);
    expect(stalledError).toBeUndefined();
    expect(stalledAcquired).toBe(true);
  } finally {
    third.release();
    stalled.release();
    replacement.release();
  }
});

it("does not clean up a different unstamped directory after its stamp fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-initialization-error-"));
  dirs.push(dir);
  const failed = new ThreadRegistryLock(dir);
  const replacement = new ThreadRegistryLock(dir);
  const movedPath = `${failed.path}.moved`;
  lockStamp.path = join(failed.path, "holder.pid");
  lockStamp.beforeWrite = () => {
    renameSync(failed.path, movedPath);
    mkdirSync(failed.path);
    throw Object.assign(new Error("injected stamp failure"), { code: "EIO" });
  };

  expect(() => failed.tryAcquire()).toThrow("failed to write registry lock holder");
  expect(existsSync(movedPath)).toBe(true);
  expect(existsSync(failed.path)).toBe(true);
  expect(replacement.tryAcquire()).toBe(false);
});

it("cleans up its own empty directory after a stamp failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-stamp-error-"));
  dirs.push(dir);
  const failed = new ThreadRegistryLock(dir);
  const next = new ThreadRegistryLock(dir);
  lockStamp.path = join(failed.path, "holder.pid");
  lockStamp.beforeWrite = () => {
    throw Object.assign(new Error("injected stamp failure"), { code: "EIO" });
  };

  expect(() => failed.tryAcquire()).toThrow("failed to write registry lock holder");
  expect(existsSync(failed.path)).toBe(false);
  try { expect(next.tryAcquire()).toBe(true); }
  finally { next.release(); }
});

it("allows only one of two reclaimers to replace the same dead holder", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-reclaim-"));
  dirs.push(dir);
  const first = new ThreadRegistryLock(dir);
  const second = new ThreadRegistryLock(dir);
  mkdirSync(first.path);
  writeFileSync(join(first.path, "holder.pid"), `${deadPid}:dead-beef`);
  const realKill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === deadPid) throw Object.assign(new Error("dead holder"), { code: "ESRCH" });
    return realKill(pid, signal);
  });

  let secondAcquired = false;
  lockRemoval.path = first.path;
  lockRemoval.beforeRemove = () => { secondAcquired = second.tryAcquire(); };
  const firstAcquired = first.tryAcquire();

  expect(Number(firstAcquired) + Number(secondAcquired)).toBe(1);
  const holder = readFileSync(join(first.path, "holder.pid"), "utf8");
  expect(holder).toMatch(/^\d+:[0-9a-f-]+$/u);
  const winner = firstAcquired ? first : second;
  const loser = firstAcquired ? second : first;
  loser.release();
  expect(readFileSync(join(first.path, "holder.pid"), "utf8")).toBe(holder);
  winner.release();
  expect(existsSync(first.path)).toBe(false);
});

it("keeps a replacement whose token changed after the dead holder was observed", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-changed-"));
  dirs.push(dir);
  const reclaimer = new ThreadRegistryLock(dir);
  mkdirSync(reclaimer.path);
  writeFileSync(join(reclaimer.path, "holder.pid"), `${deadPid}:dead-beef`);
  const replacementToken = `${process.pid}:feed-face`;
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (pid === deadPid) {
      rmSync(reclaimer.path, { recursive: true });
      mkdirSync(reclaimer.path);
      writeFileSync(join(reclaimer.path, "holder.pid"), replacementToken);
      throw Object.assign(new Error("dead holder"), { code: "ESRCH" });
    }
    return true;
  });

  expect(reclaimer.tryAcquire()).toBe(false);
  expect(readFileSync(join(reclaimer.path, "holder.pid"), "utf8")).toBe(replacementToken);
});

it("does not remove a replacement lock when its former holder releases", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-release-"));
  dirs.push(dir);
  const former = new ThreadRegistryLock(dir);
  expect(former.tryAcquire()).toBe(true);
  const original = readFileSync(join(former.path, "holder.pid"), "utf8");
  rmSync(former.path, { recursive: true });
  mkdirSync(former.path);
  writeFileSync(join(former.path, "holder.pid"), `${process.pid}:feed-face`);
  expect(readFileSync(join(former.path, "holder.pid"), "utf8")).not.toBe(original);
  former.release();
  expect(readFileSync(join(former.path, "holder.pid"), "utf8")).toBe(`${process.pid}:feed-face`);
});
