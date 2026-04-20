import { describe, expect, test } from "vitest";
import type { ConcurrencyClass } from "./concurrency.js";
import { EXCLUSIVE, SHARED_READ } from "./concurrency.js";
import type { ToolCall } from "./router.js";
import {
  partitionToolCalls,
  resolveMaxToolUseConcurrency,
  runTools,
  runToolsConcurrently,
  runToolsSerially,
} from "./orchestration.js";

function mkCall(id: string, name: string): ToolCall {
  return {
    callId: id,
    toolName: { name },
    payload: { kind: "function", arguments: "" },
  };
}

describe("orchestration", () => {
  test("partitionToolCalls splits at first non-safe", () => {
    const calls = [
      mkCall("1", "read"),
      mkCall("2", "read"),
      mkCall("3", "write"),
      mkCall("4", "read"),
    ];
    const classify = (c: ToolCall): ConcurrencyClass =>
      c.toolName.name === "read" ? SHARED_READ : EXCLUSIVE;
    const { concurrent, serial } = partitionToolCalls(calls, classify);
    expect(concurrent.map((c) => c.callId)).toEqual(["1", "2"]);
    expect(serial.map((c) => c.callId)).toEqual(["3", "4"]);
  });

  test("runToolsConcurrently respects concurrency cap", async () => {
    const concurrent: ToolCall[] = Array.from({ length: 10 }, (_, i) =>
      mkCall(String(i), "read"),
    );
    let active = 0;
    let peak = 0;
    const results = await runToolsConcurrently(
      concurrent,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => setTimeout(r, 5));
        active -= 1;
        return "ok";
      },
      { concurrency: 3 },
    );
    expect(results).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("runToolsSerially runs in order", async () => {
    const calls: ToolCall[] = ["a", "b", "c"].map((x) => mkCall(x, "w"));
    const order: string[] = [];
    await runToolsSerially(calls, async (c) => {
      order.push(`s:${c.callId}`);
      await new Promise<void>((r) => setTimeout(r, 5));
      order.push(`e:${c.callId}`);
    });
    expect(order).toEqual([
      "s:a",
      "e:a",
      "s:b",
      "e:b",
      "s:c",
      "e:c",
    ]);
  });

  test("runTools merges concurrent prefix + serial tail in original order", async () => {
    const calls = [
      mkCall("1", "read"),
      mkCall("2", "read"),
      mkCall("3", "write"),
    ];
    const classify = (c: ToolCall): ConcurrencyClass =>
      c.toolName.name === "read" ? SHARED_READ : EXCLUSIVE;
    const results = await runTools(
      calls,
      classify,
      async (c) => `R:${c.callId}`,
    );
    expect(results).toEqual(["R:1", "R:2", "R:3"]);
  });

  test("resolveMaxToolUseConcurrency default + env override", () => {
    delete process.env.AGENC_MAX_TOOL_USE_CONCURRENCY;
    expect(resolveMaxToolUseConcurrency()).toBe(10);
    process.env.AGENC_MAX_TOOL_USE_CONCURRENCY = "5";
    expect(resolveMaxToolUseConcurrency()).toBe(5);
    process.env.AGENC_MAX_TOOL_USE_CONCURRENCY = "bogus";
    expect(resolveMaxToolUseConcurrency()).toBe(10);
    delete process.env.AGENC_MAX_TOOL_USE_CONCURRENCY;
  });
});
