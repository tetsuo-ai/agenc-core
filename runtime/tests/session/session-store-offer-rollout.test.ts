import { fsyncSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { RolloutItem } from "../../src/session/rollout-item.js";
import { SessionStore } from "../../src/session/session-store.js";

// offerRollout tells a caller that keeps its own copy of an item (the rollout
// store's held lines) whether the session store took the item when its append
// failed: a taken item must not be offered again, one that was not taken is
// still the caller's to write. One test for each way the append can fail.

let home = "";
let previousHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-offer-rollout-"));
  previousHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function openStore(sessionId: string): SessionStore {
  const store = new SessionStore({ cwd: `/home/${sessionId}`, sessionId, agencVersion: "0.2.0" });
  store.open({ sessionId, timestamp: new Date().toISOString(), cwd: `/home/${sessionId}`,
    originator: "agenc-cli", agencVersion: "0.2.0" });
  return store;
}

function line(generation: number): RolloutItem {
  return { type: "session_state", payload: { userStop: { stopped: true, generation } } } as RolloutItem;
}

/** Copies of the line in the rollout file. */
const copies = (store: SessionStore, generation: number): number =>
  readFileSync(store.rolloutPath, "utf8").split("\n").filter((text) => text.includes(`"generation":${generation}`)).length;

const writtenText = (buffer: Uint8Array, offset: number, length: number): string =>
  Buffer.from(buffer.subarray(offset, offset + length)).toString("utf8");

test("an item the store writes is appended", () => {
  const store = openStore("offer-written");
  expect(store.offerRollout(line(1), { durable: true })).toEqual({ appended: true });
  expect(copies(store, 1)).toBe(1);
  store.close();
});

test("a durable item offered to a closed store is refused and not taken", () => {
  const store = openStore("offer-closed");
  store.close();
  const offer = store.offerRollout(line(2), { durable: true });
  expect(offer).toMatchObject({ appended: false, taken: false });
  expect(String((offer as { error: unknown }).error)).toContain("closed store");
  expect(copies(store, 2)).toBe(0);
});

test("an item offered while the write-behind queue has failed is refused and not taken", () => {
  const store = openStore("offer-write-behind");
  store.writeBehind.enqueue("injected", () => { throw new Error("injected persistence failure"); });
  expect(() => store.writeBehind.drain()).toThrow("injected persistence failure");
  const offer = store.offerRollout(line(3), { durable: true });
  expect(offer).toMatchObject({ appended: false, taken: false });
  expect(copies(store, 3)).toBe(0);
  expect(() => store.close()).toThrow("injected persistence failure");
});

test("an item dropped unwritten by a write error that does not enter degraded mode is not taken", () => {
  const store = openStore("offer-dropped");
  let failing = true;
  store.setWriteImplForTest((fd, buffer, offset, length) => {
    if (failing && writtenText(buffer, offset, length).includes('"generation":4')) {
      throw Object.assign(new Error("file too large"), { code: "EFBIG" });
    }
    return writeSync(fd, buffer, offset, length);
  });
  const offer = store.offerRollout(line(4), { durable: true });
  expect(offer).toMatchObject({ appended: false, taken: false });
  expect(store.isDegraded).toBe(false);
  expect(copies(store, 4)).toBe(0);
  // Offered again once the write succeeds, it is written once.
  failing = false;
  expect(store.offerRollout(line(4), { durable: true })).toEqual({ appended: true });
  expect(copies(store, 4)).toBe(1);
  store.close();
});

test("an item whose write meets a full disk is taken and written once when the disk recovers", async () => {
  const store = openStore("offer-degraded");
  let full = true;
  store.setWriteImplForTest((fd, buffer, offset, length) => {
    if (full) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return writeSync(fd, buffer, offset, length);
  });
  const offer = store.offerRollout(line(5), { durable: true });
  expect(offer).toMatchObject({ appended: false, taken: true });
  expect(store.isDegraded).toBe(true);
  expect(copies(store, 5)).toBe(0);
  full = false;
  await (store as unknown as { degraded: { tryFlush(): Promise<boolean> } }).degraded.tryFlush();
  expect(store.isDegraded).toBe(false);
  expect(copies(store, 5)).toBe(1);
  store.close();
  expect(copies(store, 5)).toBe(1);
});

test("an item whose fsync fails is taken: its bytes are already in the file", async () => {
  const store = openStore("offer-fsync");
  let failures = 0;
  store.setFsyncImplForTest((fd) => {
    if (failures === 0) {
      failures += 1;
      throw new Error("injected fsync failure");
    }
    fsyncSync(fd);
  });
  const offer = store.offerRollout(line(6), { durable: true });
  expect(offer).toMatchObject({ appended: false, taken: true });
  expect(copies(store, 6)).toBe(1);
  await store.awaitPendingFsyncRetries();
  store.close();
  expect(copies(store, 6)).toBe(1);
});
