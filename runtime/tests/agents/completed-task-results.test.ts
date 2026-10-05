import { describe, expect, it } from "vitest";
import { CompletedTaskResults, MAX_COMPLETED_TASK_RESULT_BYTES } from "../../src/agents/completed-task-results.js";

describe("completed result cache", () => {
  it("evicts the least recently read result and accounts for replacements", () => {
    const cache = new CompletedTaskResults(270);
    cache.set("a", "🐈");
    cache.set("b", "🐈");
    expect(cache.retainedBytes).toBe(268);
    expect(cache.get("a")).toBe("🐈");
    cache.set("c", "🐈");
    expect(cache.get("b")).toBeUndefined();
    cache.set("a", "");
    expect(cache.retainedBytes).toBe(264);
    cache.set("a", "x".repeat(300));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.retainedBytes).toBe(134);
  });

  it("bounds even empty results and leaves oversized answers journal-only", () => {
    const cache = new CompletedTaskResults();
    for (let i = 0; i < 20_000; i += 1) cache.set(String(i), "");
    expect(cache.retainedBytes).toBeLessThanOrEqual(MAX_COMPLETED_TASK_RESULT_BYTES);
    expect(cache.size).toBeLessThan(20_000);
    cache.set("large", "🐈".repeat(MAX_COMPLETED_TASK_RESULT_BYTES));
    expect(cache.get("large")).toBeUndefined();
    expect(cache.retainedBytes).toBeLessThanOrEqual(MAX_COMPLETED_TASK_RESULT_BYTES);
  });
});
