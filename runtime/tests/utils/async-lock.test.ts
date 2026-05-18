import { describe, expect, test } from "vitest";
import { AsyncLock } from "./async-lock.js";

describe("AsyncLock", () => {
  test("happy path: returns the function's result", async () => {
    const lock = new AsyncLock({ counter: 0 });
    const result = await lock.with((s) => {
      s.counter += 1;
      return s.counter;
    });
    expect(result).toBe(1);
  });

  test("serializes concurrent critical sections in arrival order", async () => {
    const lock = new AsyncLock<number[]>([]);
    const tasks = [0, 1, 2, 3, 4].map((i) =>
      lock.with(async (arr) => {
        await new Promise((r) => setTimeout(r, 10 - i)); // earlier callers sleep longer
        arr.push(i);
      }),
    );
    await Promise.all(tasks);
    expect(lock.unsafePeek()).toEqual([0, 1, 2, 3, 4]);
  });

  test("releases the lock when the function throws", async () => {
    const lock = new AsyncLock(0);
    await expect(
      lock.with(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Subsequent acquisition succeeds (lock isn't poisoned).
    const result = await lock.with(() => "ok");
    expect(result).toBe("ok");
  });

  test("swap returns previous value and installs new", async () => {
    const lock = new AsyncLock("first");
    const previous = await lock.swap("second");
    expect(previous).toBe("first");
    expect(lock.unsafePeek()).toBe("second");
  });
});
