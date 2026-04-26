import { describe, expect, test } from "vitest";
import {
  classify,
  defaultConcurrencyClassFor,
  EXCLUSIVE,
  isBashTool,
  isReadOnlyFilesystemTool,
  isWriteFilesystemTool,
  Semaphore,
  SHARED_READ,
  sharedServer,
  ToolCallRuntime,
} from "./concurrency.js";

describe("Semaphore (I-61)", () => {
  test("acquire up to capacity then queue", async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.available).toBe(0);
    const waiter = sem.acquire();
    expect(sem.queueDepth).toBe(1);
    r1();
    const r3 = await waiter;
    r2();
    r3();
    expect(sem.available).toBe(2);
  });
});

describe("ToolCallRuntime (parallel.rs port)", () => {
  test("shared_read runs in parallel; exclusive serializes", async () => {
    const runtime = new ToolCallRuntime();
    const order: string[] = [];
    const sleeper = (label: string, ms: number) => async () => {
      order.push(`start:${label}`);
      await new Promise<void>((r) => setTimeout(r, ms));
      order.push(`end:${label}`);
      return label;
    };
    const [a, b] = await Promise.all([
      runtime.run(SHARED_READ, sleeper("a", 20)),
      runtime.run(SHARED_READ, sleeper("b", 20)),
    ]);
    expect([a, b]).toEqual(["a", "b"]);
    // Both should have overlapped — starts before ends.
    const aEnd = order.indexOf("end:a");
    const bStart = order.indexOf("start:b");
    expect(bStart).toBeLessThan(aEnd);

    // Exclusive after serialises.
    order.length = 0;
    await Promise.all([
      runtime.run(SHARED_READ, sleeper("r1", 20)),
      runtime.run(EXCLUSIVE, sleeper("w", 20)),
      runtime.run(SHARED_READ, sleeper("r2", 20)),
    ]);
    // w starts only after first r1 ends, and r2 starts only after w ends.
    expect(order.indexOf("start:w")).toBeGreaterThan(order.indexOf("end:r1"));
    expect(order.indexOf("start:r2")).toBeGreaterThan(order.indexOf("end:w"));
  });

  test("shared_server uses per-id semaphore (I-61)", async () => {
    const runtime = new ToolCallRuntime({ sharedServerCapacity: 1 });
    const events: string[] = [];
    const run = (id: string) => async () => {
      events.push(`start:${id}`);
      await new Promise<void>((r) => setTimeout(r, 15));
      events.push(`end:${id}`);
      return id;
    };
    await Promise.all([
      runtime.run(sharedServer("dbA"), run("a1")),
      runtime.run(sharedServer("dbA"), run("a2")),
      runtime.run(sharedServer("dbB"), run("b1")),
    ]);
    // dbA calls serialize per-id.
    expect(events.indexOf("start:a2")).toBeGreaterThan(
      events.indexOf("end:a1"),
    );
    // dbB runs in parallel with dbA (no shared semaphore).
    expect(events.indexOf("start:b1")).toBeLessThan(events.indexOf("end:a2"));
  });
});

describe("classify + defaultConcurrencyClassFor", () => {
  test("read-only fs tools → SharedRead", () => {
    expect(defaultConcurrencyClassFor("FileRead").kind).toBe("shared_read");
    expect(isReadOnlyFilesystemTool("FileRead")).toBe(true);
  });

  test("write fs tools → Exclusive", () => {
    expect(defaultConcurrencyClassFor("Write").kind).toBe(
      "exclusive",
    );
    expect(isWriteFilesystemTool("Write")).toBe(true);
  });

  test("bash → BackgroundTerminal", () => {
    expect(defaultConcurrencyClassFor("system.bash").kind).toBe(
      "background_terminal",
    );
    expect(isBashTool("system.bash")).toBe(true);
    expect(defaultConcurrencyClassFor("exec_command").kind).toBe(
      "background_terminal",
    );
    expect(isBashTool("exec_command")).toBe(true);
  });

  test("classify respects per-call isConcurrencySafe false → Exclusive", () => {
    const klass = classify(
      {
        name: "system.bash",
        concurrencyClass: SHARED_READ,
        isConcurrencySafe: () => false,
      },
      {},
    );
    expect(klass.kind).toBe("exclusive");
  });
});
