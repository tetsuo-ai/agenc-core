const lockRemoval = vi.hoisted(() => ({ path: "", beforeRemove: undefined as undefined | (() => void) }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, rmSync: ((path: Parameters<typeof fs.rmSync>[0], options?: Parameters<typeof fs.rmSync>[1]) => {
    if (String(path) === lockRemoval.path && lockRemoval.beforeRemove) {
      const callback = lockRemoval.beforeRemove;
      lockRemoval.beforeRemove = undefined;
      callback();
    }
    return fs.rmSync(path, options);
  }) as typeof fs.rmSync };
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadRegistryLock } from "../../src/thread-store/registry-lock.js";

const deadPid = 2_147_483_647;
const dirs: string[] = [];

afterEach(() => {
  lockRemoval.path = "";
  lockRemoval.beforeRemove = undefined;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
