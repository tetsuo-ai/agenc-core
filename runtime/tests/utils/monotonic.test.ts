import { describe, expect, test } from "vitest";
import { monotonicMs, monotonicNs, startElapsedMs } from "./monotonic.js";

describe("monotonicMs", () => {
  test("returns a finite non-negative number", () => {
    const t = monotonicMs();
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThanOrEqual(0);
  });

  test("is monotonically non-decreasing across calls", () => {
    const a = monotonicMs();
    const b = monotonicMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  test("advances after a sleep", async () => {
    const a = monotonicMs();
    await new Promise((r) => setTimeout(r, 20));
    const b = monotonicMs();
    expect(b).toBeGreaterThan(a);
  });
});

describe("monotonicNs", () => {
  test("returns a positive bigint", () => {
    const t = monotonicNs();
    expect(typeof t).toBe("bigint");
    expect(t > 0n).toBe(true);
  });

  test("is monotonically non-decreasing", () => {
    const a = monotonicNs();
    const b = monotonicNs();
    expect(b >= a).toBe(true);
  });
});

describe("startElapsedMs", () => {
  test("starts at ~0 and advances", async () => {
    const elapsed = startElapsedMs();
    expect(elapsed()).toBeLessThan(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(elapsed()).toBeGreaterThan(0);
  });
});
