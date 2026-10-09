import { describe, expect, it } from "vitest";
import { SessionWriteBehindQueue, currentSessionWriteBehind, withSessionWriteBehind, registerSessionWriteBehind, finishAllSessionWriteBehind } from "../../src/session/write-behind.js";

describe("session write-behind queue", () => {
  it("finishes other registered sessions before reporting a daemon shutdown failure", () => {
    const failed = new SessionWriteBehindQueue();
    const healthy = new SessionWriteBehindQueue();
    const releaseFailed = registerSessionWriteBehind("queue-tests/failed/rollout.jsonl", failed);
    const releaseHealthy = registerSessionWriteBehind("queue-tests/healthy/rollout.jsonl", healthy);
    const failure = new Error("one session lost its disk");
    let committed = false;
    try {
      failed.beginStep(); healthy.beginStep();
      failed.defer("failed", () => { throw failure; });
      healthy.defer("other-session", () => { committed = true; });
      expect(() => finishAllSessionWriteBehind()).toThrow(failure);
      expect(committed).toBe(true);
      expect(healthy.pending).toBe(0);
      expect(healthy.deferring).toBe(false);
      expect(failed.pending).toBe(1);
      expect(() => failed.drain()).toThrow(failure);
    } finally { releaseFailed(); releaseHealthy(); }
  });

  it("runs jobs in order, keeps nested work synchronous, and closes the loss window", () => {
    const queue = new SessionWriteBehindQueue();
    const seen: number[] = [];
    expect(queue.defer("outside", () => seen.push(0))).toBe(false);
    queue.beginStep();
    queue.defer("first", () => {
      seen.push(1);
      expect(queue.defer("nested", () => seen.push(99))).toBe(false);
      seen.push(2);
    });
    queue.defer("second", () => seen.push(3));
    expect(seen).toEqual([]);
    queue.finish();
    expect(seen).toEqual([1, 2, 3]);
    expect(queue.pending).toBe(0);
    expect(queue.deferring).toBe(false);
  });

  it("retains a failed job and every successor and rethrows the original failure", () => {
    const queue = new SessionWriteBehindQueue();
    const error = new Error("disk full");
    queue.beginStep();
    queue.defer("failed", () => { throw error; });
    queue.defer("later", () => { throw new Error("must not run"); });
    expect(() => queue.drain()).toThrow(error);
    expect(queue.pending).toBe(2);
    expect(() => queue.finish()).toThrow(error);
    expect(() => queue.defer("new", () => {})).toThrow(error);
  });

  it("flushes a preceding step before opening another", () => {
    const queue = new SessionWriteBehindQueue();
    let committed = false;
    queue.beginStep();
    queue.defer("old", () => { committed = true; });
    queue.beginStep();
    expect(committed).toBe(true);
    expect(queue.pending).toBe(0);
  });

  it("isolates concurrent async session scopes", async () => {
    const first = new SessionWriteBehindQueue();
    const second = new SessionWriteBehindQueue();
    await Promise.all([first, second].map((queue) => withSessionWriteBehind(queue, async () => {
      await Promise.resolve();
      expect(currentSessionWriteBehind()).toBe(queue);
    })));
    expect(currentSessionWriteBehind()).toBeUndefined();
  });

  it("restores the owning session scope when another session forces the flush", () => {
    const owner = new SessionWriteBehindQueue();
    const reader = new SessionWriteBehindQueue();
    let observed: SessionWriteBehindQueue | undefined;
    withSessionWriteBehind(owner, () => {
      owner.beginStep();
      owner.defer("owned", () => { observed = currentSessionWriteBehind(); });
    });
    withSessionWriteBehind(reader, () => {
      owner.drain();
      expect(currentSessionWriteBehind()).toBe(reader);
    });
    expect(observed).toBe(owner);
  });
});
