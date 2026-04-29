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
