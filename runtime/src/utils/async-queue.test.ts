import { describe, expect, test } from "vitest";
import { AsyncQueue } from "./async-queue.js";

describe("AsyncQueue", () => {
  test("happy path: send + recv FIFO", async () => {
    const q = new AsyncQueue<number>();
    expect(q.send(1)).toBe(true);
    expect(q.send(2)).toBe(true);
    expect(q.send(3)).toBe(true);
    expect(await q.recv()).toBe(1);
    expect(await q.recv()).toBe(2);
    expect(await q.recv()).toBe(3);
  });

  test("recv awaits until send arrives", async () => {
    const q = new AsyncQueue<string>();
    const recvPromise = q.recv();
    setTimeout(() => q.send("late"), 5);
    expect(await recvPromise).toBe("late");
  });

  test("close terminates pending recv with null and rejects future sends", async () => {
    const q = new AsyncQueue<number>();
    const recvPromise = q.recv();
    q.close();
    expect(await recvPromise).toBeNull();
    expect(q.send(99)).toBe(false);
    expect(await q.recv()).toBeNull();
    expect(q.isClosed).toBe(true);
  });

  test("bounded queue rejects when full (no waiter)", () => {
    const q = new AsyncQueue<number>({ maxDepth: 2 });
    expect(q.send(1)).toBe(true);
    expect(q.send(2)).toBe(true);
    expect(q.send(3)).toBe(false);
    expect(q.size).toBe(2);
  });

  test("bounded queue accepts new send if a waiter is ready", async () => {
    const q = new AsyncQueue<number>({ maxDepth: 1 });
    q.send(1);
    const recvPromise = q.recv();
    expect(await recvPromise).toBe(1);
    // After draining, send should succeed again.
    expect(q.send(2)).toBe(true);
    expect(await q.recv()).toBe(2);
  });

  test("stream() iterates until close", async () => {
    const q = new AsyncQueue<number>();
    const collected: number[] = [];
    const consumer = (async () => {
      for await (const item of q.stream()) collected.push(item);
    })();
    q.send(10);
    q.send(20);
    q.send(30);
    setTimeout(() => q.close(), 5);
    await consumer;
    expect(collected).toEqual([10, 20, 30]);
  });

  test("tryRecv returns undefined for empty open queue", () => {
    const q = new AsyncQueue<number>();
    expect(q.tryRecv()).toBeUndefined();
    q.send(1);
    expect(q.tryRecv()).toBe(1);
    q.close();
    expect(q.tryRecv()).toBeNull();
  });
});
