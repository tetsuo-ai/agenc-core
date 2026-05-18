import { describe, expect, test } from "vitest";
import { AsyncRwLock } from "./async-rwlock.js";

describe("AsyncRwLock", () => {
  test("happy path: read and write return values", async () => {
    const lock = new AsyncRwLock({ value: 1 });
    const read = await lock.withRead((s) => s.value);
    expect(read).toBe(1);
    const written = await lock.withWrite((s) => {
      s.value = 2;
      return s.value;
    });
    expect(written).toBe(2);
  });

  test("multiple readers run concurrently", async () => {
    const lock = new AsyncRwLock("data");
    const order: string[] = [];
    const readers = [0, 1, 2].map((i) =>
      lock.withRead(async () => {
        order.push(`start-${i}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end-${i}`);
      }),
    );
    await Promise.all(readers);
    // All starts should precede all ends (concurrent).
    expect(order.slice(0, 3).every((s) => s.startsWith("start"))).toBe(true);
    expect(order.slice(3).every((s) => s.startsWith("end"))).toBe(true);
  });

  test("writer waits for all readers to drain", async () => {
    const lock = new AsyncRwLock<number[]>([]);
    const order: string[] = [];

    const reader = lock.withRead(async (s) => {
      order.push("read-start");
      await new Promise((r) => setTimeout(r, 20));
      s.push(0);
      order.push("read-end");
    });

    // Tiny delay so the read enters the critical section first.
    await new Promise((r) => setTimeout(r, 1));

    const writer = lock.withWrite(async (s) => {
      order.push("write-start");
      s.push(1);
      order.push("write-end");
    });

    await Promise.all([reader, writer]);
    expect(order).toEqual(["read-start", "read-end", "write-start", "write-end"]);
    expect(lock).toBeDefined();
  });

  test("queued writer prevents new readers from starving it", async () => {
    const lock = new AsyncRwLock<string[]>([]);
    const order: string[] = [];

    const reader1 = lock.withRead(async (s) => {
      order.push("r1-start");
      await new Promise((r) => setTimeout(r, 20));
      s.push("r1");
      order.push("r1-end");
    });

    await new Promise((r) => setTimeout(r, 1));
    const writer = lock.withWrite(async (s) => {
      order.push("w-start");
      s.push("w");
      order.push("w-end");
    });

    await new Promise((r) => setTimeout(r, 1));
    const reader2 = lock.withRead(async (s) => {
      order.push("r2-start");
      s.push("r2");
      order.push("r2-end");
    });

    await Promise.all([reader1, writer, reader2]);
    // r2 must wait for the queued writer (no read after write enqueued
    // until the writer completes).
    const writeIdx = order.indexOf("w-end");
    const r2Idx = order.indexOf("r2-start");
    expect(r2Idx).toBeGreaterThan(writeIdx);
  });
});
