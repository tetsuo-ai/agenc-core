import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RolloutItem } from "../../src/session/rollout-item.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { backfillRolloutFile } from "../../src/state/backfill.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../src/state/threads.js";
import {
  FileThreadStore,
  LIVE_ROLLOUT_INDEX_DELAY_MS,
} from "../../src/thread-store/store.js";

// Job og: inside a turn the SQLite mirror of a live rollout used to run one
// transaction per append (a dozen between two model requests, one every 100 ms
// while a reply streamed), on the path to the next model request and writing
// most of the state WAL. In-turn commits are now mirrored together.

let agencHome = "";
let cwd = "";
const closers: Array<() => void> = [];

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-live-index-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-live-index-cwd-"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (closers.length > 0) closers.pop()!();
  rmSync(agencHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function openLiveThread(sessionId: string): { rollout: RolloutStore; store: FileThreadStore } {
  const rollout = new RolloutStore({
    agencHome,
    cwd,
    sessionId,
    agencVersion: "0.2.0",
    sessionTempRoot: tmpdir(),
  });
  rollout.open({
    sessionId,
    timestamp: new Date().toISOString(),
    cwd,
    originator: "live-index-test",
    agencVersion: "0.2.0",
    model: "test-model",
    modelProvider: "test-provider",
  });
  const store = new FileThreadStore({ agencHome, cwd });
  store.createThread({ threadId: sessionId, rolloutStore: rollout });
  closers.push(() => {
    try { store.close(); } catch { /* already closed */ }
    try { rollout.close(); } catch { /* already closed */ }
  });
  return { rollout, store };
}

function item(id: string): RolloutItem {
  return { type: "response_item", payload: { role: "user", content: `item ${id}`, id } };
}

/** Bytes of the rollout the SQLite mirror has indexed (its backfill receipt). */
function mirroredBytes(rolloutPath: string): number {
  const driver = openStateDatabases({ agencHome, cwd });
  try {
    return new StateThreadRepository(driver).getBackfillFile(rolloutPath)?.size ?? 0;
  } finally {
    driver.close();
  }
}

describe("live rollout mirror", () => {
  it("mirrors a commit made outside a turn at once", () => {
    const { rollout } = openLiveThread("outside-turn");
    rollout.appendRollout(item("a"), { durable: true });
    expect(mirroredBytes(rollout.rolloutPath)).toBe(statSync(rollout.rolloutPath).size);
  });

  it("mirrors the commits of a turn together, at most the delay after the first", () => {
    const { rollout } = openLiveThread("inside-turn");
    const projection = vi.spyOn(StateThreadRepository.prototype, "appendRolloutProjection");
    const before = mirroredBytes(rollout.rolloutPath);
    const release = rollout.deferSyncsForTurn();
    try {
      rollout.appendRollout(item("a"), { durable: true });
      rollout.appendRollout(item("b"), { durable: true });
      rollout.appendRollout(item("c"), { durable: true });
      // The appends are in the file before the next model request; the mirror
      // has not run for them yet.
      expect(statSync(rollout.rolloutPath).size).toBeGreaterThan(before);
      expect(mirroredBytes(rollout.rolloutPath)).toBe(before);
      expect(projection).not.toHaveBeenCalled();
      vi.advanceTimersByTime(LIVE_ROLLOUT_INDEX_DELAY_MS - 1);
      expect(projection).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(projection).toHaveBeenCalledTimes(1);
      expect(mirroredBytes(rollout.rolloutPath)).toBe(statSync(rollout.rolloutPath).size);
    } finally {
      release("sync");
    }
  });

  it("catches up at the turn boundary in one pass, in file order", () => {
    const { rollout } = openLiveThread("after-turn");
    const projection = vi.spyOn(StateThreadRepository.prototype, "appendRolloutProjection");
    const release = rollout.deferSyncsForTurn();
    rollout.appendRollout(item("a"), { durable: true });
    rollout.appendRollout(item("b"), { durable: true });
    expect(projection).not.toHaveBeenCalled();
    // A completed or aborted turn releases its scope: the mirror is current
    // again without waiting for the timer, as when every commit was mirrored.
    release("background");
    expect(projection).toHaveBeenCalledTimes(1);
    const items = projection.mock.calls[0]![0].items;
    expect(items.map((row) => JSON.parse(row.payloadJson).id)).toEqual(["a", "b"]);
    expect(mirroredBytes(rollout.rolloutPath)).toBe(statSync(rollout.rolloutPath).size);
    // The cancelled timer has nothing left to do; later commits outside a
    // turn are mirrored at once.
    vi.advanceTimersByTime(LIVE_ROLLOUT_INDEX_DELAY_MS);
    expect(projection).toHaveBeenCalledTimes(1);
    rollout.appendRollout(item("c"), { durable: true });
    expect(projection).toHaveBeenCalledTimes(2);
  });

  it("announces a turn boundary only after in-turn commits", () => {
    const { rollout } = openLiveThread("quiet-turn");
    const projection = vi.spyOn(StateThreadRepository.prototype, "appendRolloutProjection");
    rollout.deferSyncsForTurn()("sync");
    expect(projection).not.toHaveBeenCalled();
  });

  it("catches up at once when the writer is shut down", () => {
    const { rollout, store } = openLiveThread("shutdown");
    const release = rollout.deferSyncsForTurn();
    rollout.appendRollout(item("a"), { durable: true });
    release("sync");
    store.shutdownThread("shutdown");
    expect(mirroredBytes(rollout.rolloutPath)).toBe(statSync(rollout.rolloutPath).size);
  });

  it("catches up at once when the store closes", () => {
    const { rollout, store } = openLiveThread("close");
    const release = rollout.deferSyncsForTurn();
    rollout.appendRollout(item("a"), { durable: true });
    release("sync");
    store.close();
    expect(mirroredBytes(rollout.rolloutPath)).toBe(statSync(rollout.rolloutPath).size);
  });

  it("catches up at once for an explicit append through the store", () => {
    const { rollout, store } = openLiveThread("explicit");
    const release = rollout.deferSyncsForTurn();
    try {
      rollout.appendRollout(item("a"), { durable: true });
      store.appendItems({ threadId: "explicit", items: [item("b")] });
      expect(mirroredBytes(rollout.rolloutPath)).toBe(statSync(rollout.rolloutPath).size);
    } finally {
      release("sync");
    }
  });

  it("leaves a tail the mirror never reached for the next index of the file", () => {
    const { rollout } = openLiveThread("rebuild");
    const release = rollout.deferSyncsForTurn();
    try {
      rollout.appendRollout(item("a"), { durable: true });
      rollout.appendRollout(item("b"), { durable: true });
      const indexed = mirroredBytes(rollout.rolloutPath);
      expect(indexed).toBeLessThan(statSync(rollout.rolloutPath).size);
      // A process that died before the timer fired: the next process's index
      // of this file (startup backfill, a read) reads the unmirrored tail.
      const driver = openStateDatabases({ agencHome, cwd });
      try {
        backfillRolloutFile({ rolloutPath: rollout.rolloutPath, threads: new StateThreadRepository(driver) });
      } finally {
        driver.close();
      }
      expect(mirroredBytes(rollout.rolloutPath)).toBe(statSync(rollout.rolloutPath).size);
    } finally {
      release("sync");
    }
  });
});
