import { describe, expect, test } from "vitest";
import { DegradedStore } from "./degraded-store.js";

describe("DegradedStore (I-12, I-38, I-43)", () => {
  test("append accumulates + evicts on overflow", () => {
    const evicted: number[] = [];
    const store = new DegradedStore<number>({
      capacity: 3,
      flushFn: async () => true,
      onStatusChange: (c) => {
        if (c.kind === "evicted") evicted.push(c.evicted);
      },
    });
    store.enterDegraded("test");
    store.append(1);
    store.append(2);
    store.append(3);
    store.append(4);
    store.append(5);
    expect(store.size).toBe(3);
    expect(store.snapshot()).toEqual([3, 4, 5]);
    expect(evicted.length).toBeGreaterThan(0);
  });

  test("tryFlush drains on success and exits degraded", async () => {
    let flushed: number[] = [];
    const store = new DegradedStore<number>({
      capacity: 5,
      flushFn: async (evs) => {
        flushed = [...evs];
        return true;
      },
    });
    store.enterDegraded("test");
    store.append(1);
    store.append(2);
    expect(store.isDegraded).toBe(true);
    const ok = await store.tryFlush();
    expect(ok).toBe(true);
    expect(flushed).toEqual([1, 2]);
    expect(store.isDegraded).toBe(false);
  });

  test("tryFlush failure keeps buffer + stays degraded", async () => {
    const store = new DegradedStore<number>({
      capacity: 5,
      flushFn: async () => false,
    });
    store.enterDegraded("test");
    store.append(1);
    store.append(2);
    const ok = await store.tryFlush();
    expect(ok).toBe(false);
    expect(store.isDegraded).toBe(true);
    expect(store.snapshot()).toEqual([1, 2]);
  });

  test("throw in flushFn treated as failure", async () => {
    const store = new DegradedStore<number>({
      capacity: 5,
      flushFn: async () => {
        throw new Error("disk still broken");
      },
    });
    store.enterDegraded("test");
    store.append(1);
    const ok = await store.tryFlush();
    expect(ok).toBe(false);
    expect(store.isDegraded).toBe(true);
  });

  test("#12 concurrent at-capacity append during in-flight flush does not drop a buffered-unflushed event", async () => {
    let flushed: number[] = [];
    let startedFlush!: () => void;
    const flushStarted = new Promise<void>((resolve) => {
      startedFlush = resolve;
    });
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });

    const store = new DegradedStore<number>({
      capacity: 3,
      flushFn: async (evs) => {
        flushed = [...evs];
        startedFlush();
        await flushGate;
        return true;
      },
    });
    store.enterDegraded("test");
    // Fill exactly to capacity.
    store.append(1);
    store.append(2);
    store.append(3);
    expect(store.size).toBe(3);

    // Start the flush but don't await — flushFn parks on flushGate.
    const flushPromise = store.tryFlush();
    await flushStarted;

    // Concurrent appends arrive while the flush is in flight. Under the
    // old index-based splice these would push the at-capacity buffer over
    // the limit, evict the front, and then the post-flush
    // `splice(0, toFlush.length)` would remove these never-flushed items
    // (data loss). Draining by identity keeps them safe.
    store.append(4);
    store.append(5);

    releaseFlush();
    const ok = await flushPromise;
    expect(ok).toBe(true);

    // The flush only ever saw the original snapshot.
    expect(flushed).toEqual([1, 2, 3]);
    // The concurrently-appended, never-flushed items must survive.
    expect(store.snapshot()).toEqual([4, 5]);
    // They were not flushed, so we must still be degraded.
    expect(store.isDegraded).toBe(true);
  });

  test("#12 flush failure re-prepends drained items ahead of concurrent appends", async () => {
    let startedFlush!: () => void;
    const flushStarted = new Promise<void>((resolve) => {
      startedFlush = resolve;
    });
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });

    const store = new DegradedStore<number>({
      capacity: 10,
      flushFn: async () => {
        startedFlush();
        await flushGate;
        return false; // disk still broken — must re-queue drained slice
      },
    });
    store.enterDegraded("test");
    store.append(1);
    store.append(2);

    const flushPromise = store.tryFlush();
    await flushStarted;

    // Arrives during the in-flight (failing) flush.
    store.append(3);

    releaseFlush();
    const ok = await flushPromise;
    expect(ok).toBe(false);

    // Drained items re-prepended ahead of the concurrent append; nothing
    // lost, order preserved, still degraded.
    expect(store.snapshot()).toEqual([1, 2, 3]);
    expect(store.isDegraded).toBe(true);
  });

  test("evictedCount tracks total overflow", () => {
    const store = new DegradedStore<number>({
      capacity: 2,
      flushFn: async () => true,
    });
    store.enterDegraded("test");
    for (let i = 0; i < 10; i += 1) store.append(i);
    expect(store.evictedCount).toBe(8);
  });
});
