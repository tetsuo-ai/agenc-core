import { getEventListeners } from "node:events";
import { chmodSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acquireLocalSqliteLock } from "../../src/utils/sqlite-lock.js";

let root: string;
const owners: DatabaseSync[] = [];
const hints: AbortController[] = [];
const attempts: Promise<unknown>[] = [];
const heldReleases: (() => void)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-lock-ready-"));
  chmodSync(root, 0o700);
});
afterEach(async () => {
  for (const release of heldReleases.splice(0)) release();
  for (const owner of owners.splice(0)) {
    if (owner.isTransaction) owner.exec("ROLLBACK");
    if (owner.isOpen) owner.close();
  }
  for (const hint of hints.splice(0)) hint.abort();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.allSettled(attempts.splice(0));
  rmSync(root, { recursive: true, force: true });
});

async function heldLock(name = "lifecycle.sqlite") {
  const path = join(root, name);
  (await acquireLocalSqliteLock(path))();
  // The same OS writer lock held by a non-signalling/older implementation;
  // bypass the process-local FIFO so the real SQLite BUSY path is exercised.
  const owner = new DatabaseSync(path, { timeout: 0 });
  owners.push(owner);
  owner.exec("BEGIN IMMEDIATE");
  return { path, owner };
}
function readyHint() {
  const hint = new AbortController();
  hints.push(hint);
  return hint;
}
function track<T>(promise: Promise<T>): Promise<T> {
  // Observe failures immediately; each test still awaits the original result.
  attempts.push(promise.then((release) => {
    if (typeof release === "function") release();
  }, () => {}));
  return promise;
}

it("wakes an active backoff after release without advancing its timer", async () => {
  const { path, owner } = await heldLock();
  const hint = readyHint();
  const waiting = Promise.withResolvers<void>();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = track(acquireLocalSqliteLock(path, {
    retryWakeSignal: hint.signal,
    onProgress: (phase) => { if (phase === "SQLite busy retry wait started") waiting.resolve(); },
  }));
  await waiting.promise;
  expect(getEventListeners(hint.signal, "abort")).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(1);
  owner.exec("ROLLBACK");
  hint.abort();
  (await pending)();
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(hint.signal, "abort")).toHaveLength(0);
});

it("retains readiness received before the first busy wait", async () => {
  const { path, owner } = await heldLock();
  const hint = readyHint();
  hint.abort();
  let attemptsToBegin = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const release = await track(acquireLocalSqliteLock(path, {
    retryWakeSignal: hint.signal,
    onProgress: (phase) => {
      if (phase === "SQLite transaction begin started" && ++attemptsToBegin === 2) owner.exec("ROLLBACK");
    },
  }));
  release();
  expect(attemptsToBegin).toBe(2);
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(hint.signal, "abort")).toHaveLength(0);
});

it("does not need readiness when the older holder already released", async () => {
  const { path, owner } = await heldLock();
  const hint = readyHint();
  owner.exec("ROLLBACK");
  const phases: string[] = [];
  (await track(acquireLocalSqliteLock(path, {
    retryWakeSignal: hint.signal, onProgress: (phase) => { phases.push(phase); },
  })))();
  expect(phases).not.toContain("SQLite busy retry wait started");
  expect(getEventListeners(hint.signal, "abort")).toHaveLength(0);
  hint.abort();
});

it("covers READY arriving during listener registration", async () => {
  const { path, owner } = await heldLock();
  const hint = readyHint();
  const add = hint.signal.addEventListener.bind(hint.signal);
  vi.spyOn(hint.signal, "addEventListener").mockImplementationOnce((type, listener, options) => {
    hint.abort();
    add(type, listener, options);
  });
  let begins = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  (await track(acquireLocalSqliteLock(path, {
    retryWakeSignal: hint.signal,
    onProgress: (phase) => {
      if (phase === "SQLite transaction begin started" && ++begins === 2) owner.exec("ROLLBACK");
    },
  })))();
  expect(begins).toBe(2);
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(hint.signal, "abort")).toHaveLength(0);
});

it("cleans up the timer if listener registration throws synchronously", async () => {
  const { path, owner } = await heldLock();
  const hint = readyHint();
  const failure = new Error("listener registration failed");
  vi.spyOn(hint.signal, "addEventListener").mockImplementationOnce(() => { throw failure; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await expect(track(acquireLocalSqliteLock(path, { retryWakeSignal: hint.signal }))).rejects.toBe(failure);
  expect(owner.isTransaction).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(hint.signal, "abort")).toHaveLength(0);
  owner.exec("ROLLBACK");
  (await acquireLocalSqliteLock(path))();
});

it("removes the listener on ordinary retry expiry when no READY arrives", async () => {
  const { path, owner } = await heldLock();
  const hint = readyHint();
  const waiting = Promise.withResolvers<void>();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = track(acquireLocalSqliteLock(path, {
    retryWakeSignal: hint.signal,
    onProgress: (phase) => { if (phase === "SQLite busy retry wait started") waiting.resolve(); },
  }));
  await waiting.promise;
  owner.exec("ROLLBACK");
  await vi.advanceTimersToNextTimerAsync();
  (await pending)();
  expect(hint.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(hint.signal, "abort")).toHaveLength(0);
});

it("consumes one wake and still times out while an older holder owns the lock", async () => {
  const { path, owner } = await heldLock();
  const hint = readyHint();
  hint.abort();
  let hintedWaits = 0;
  const deadline = performance.now() + 10_000;
  let opens = 0;
  await expect(track(acquireLocalSqliteLock(path, {
    retryWakeSignal: hint.signal, timeoutMs: 10_000, deadline,
    onProgress: (phase) => {
      if (phase === "SQLite busy retry wait started") hintedWaits++;
      if (phase === "SQLite pre-open lock validation started" && ++opens === 3) {
        vi.spyOn(performance, "now").mockReturnValue(deadline + 1);
      }
    },
  }))).rejects.toMatchObject({ code: "AGENC_LOCK_TIMEOUT", timeoutMs: 10_000, path });
  expect(hintedWaits).toBe(1);
  expect(owner.isTransaction).toBe(true);
  expect(getEventListeners(hint.signal, "abort")).toHaveLength(0);
  vi.restoreAllMocks();
  owner.exec("ROLLBACK");
  (await acquireLocalSqliteLock(path))();
});

it("can acquire after READY when an older holder releases on a later retry", async () => {
  const { path, owner } = await heldLock();
  const hint = readyHint();
  let begins = 0;
  let hintedWaits = 0;
  let heldAfterWake = false;
  (await track(acquireLocalSqliteLock(path, {
    retryWakeSignal: hint.signal,
    onProgress: (phase) => {
      if (phase === "SQLite busy retry wait started") { hintedWaits++; hint.abort(); }
      if (phase === "SQLite transaction begin started") {
        begins++;
        if (begins === 2) heldAfterWake = owner.isTransaction;
        if (begins === 3) owner.exec("ROLLBACK");
      }
    },
  })))();
  expect(begins).toBe(3);
  expect(hintedWaits).toBe(1);
  expect(heldAfterWake).toBe(true);
  expect(owner.isTransaction).toBe(false);
});

it("does not renew the shared deadline when READY arrives after expiry", async () => {
  const { path, owner } = await heldLock();
  const hint = readyHint();
  const waiting = Promise.withResolvers<void>();
  const deadline = performance.now() + 10_000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = track(acquireLocalSqliteLock(path, {
    retryWakeSignal: hint.signal, timeoutMs: 10_000, deadline,
    onProgress: (phase) => { if (phase === "SQLite busy retry wait started") waiting.resolve(); },
  }));
  await waiting.promise;
  owner.exec("ROLLBACK");
  vi.spyOn(performance, "now").mockReturnValue(deadline + 1);
  hint.abort();
  await expect(pending).rejects.toMatchObject({ code: "AGENC_LOCK_TIMEOUT", path });
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(hint.signal, "abort")).toHaveLength(0);
});

it("revalidates the lock inode after a readiness wake", async () => {
  const { path, owner } = await heldLock();
  const replacement = join(root, "replacement.sqlite");
  (await acquireLocalSqliteLock(replacement))();
  const hint = readyHint();
  const waiting = Promise.withResolvers<void>();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = track(acquireLocalSqliteLock(path, {
    retryWakeSignal: hint.signal,
    onProgress: (phase) => { if (phase === "SQLite busy retry wait started") waiting.resolve(); },
  }));
  await waiting.promise;
  owner.exec("ROLLBACK");
  renameSync(path, join(root, "old.sqlite"));
  renameSync(replacement, path);
  hint.abort();
  await expect(pending).rejects.toThrow(/identity changed during acquisition/u);
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(hint.signal, "abort")).toHaveLength(0);
});

it("does not let readiness bypass the same-process FIFO owner", async () => {
  const path = join(root, "fifo.sqlite");
  const first = await acquireLocalSqliteLock(path);
  heldReleases.push(first);
  const hint = readyHint();
  hint.abort();
  let acquired = false;
  const second = track(acquireLocalSqliteLock(path, { retryWakeSignal: hint.signal }).then((release) => {
    acquired = true;
    return release;
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(acquired).toBe(false);
  first();
  (await second)();
});
