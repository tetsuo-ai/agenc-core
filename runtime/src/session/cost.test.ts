import { describe, expect, test } from "vitest";
import {
  CostSidecar,
  computeUsdCost,
  DEFAULT_MODEL_COSTS,
  formatUsdCost,
  formatTokenCount,
  formatDuration,
} from "./cost.js";

describe("cost helpers", () => {
  test("formatUsdCost", () => {
    expect(formatUsdCost(0)).toBe("$0.00");
    expect(formatUsdCost(0.0001)).toBe("$0.0001");
    expect(formatUsdCost(0.5)).toBe("$0.500");
    expect(formatUsdCost(12.345)).toBe("$12.35");
  });

  test("formatTokenCount", () => {
    expect(formatTokenCount(500)).toBe("500");
    expect(formatTokenCount(1500)).toBe("1.5K");
    expect(formatTokenCount(2_500_000)).toBe("2.50M");
  });

  test("formatDuration", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(15_000)).toBe("15.0s");
    expect(formatDuration(125_000)).toBe("2m5s");
  });

  test("computeUsdCost with known model", () => {
    const usage = {
      model: "grok-4-fast",
      inputTokens: 10_000,
      outputTokens: 5_000,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 15_000,
      turns: 1,
    };
    const cost = computeUsdCost(usage, DEFAULT_MODEL_COSTS);
    // input 10_000 * 0.002 / 1000 = 0.02; output 5_000 * 0.01 / 1000 = 0.05 → 0.07
    expect(cost).toBeCloseTo(0.07, 4);
  });
});

describe("CostSidecar", () => {
  test("accumulates per-model token usage", () => {
    const sidecar = new CostSidecar();
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: { type: "session_meta", payload: { sessionId: "s", timestamp: "", cwd: "", originator: "", agencVersion: "0.2.0", rolloutSchemaVersion: 1, model: "grok-4-fast" } },
    });
    sidecar.onEvent({
      id: "2",
      seq: 2,
      msg: {
        type: "token_count",
        payload: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      },
    });
    sidecar.onEvent({
      id: "3",
      seq: 3,
      msg: {
        type: "token_count",
        payload: { promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 },
      },
    });
    expect(sidecar.getTotalInputTokens()).toBe(3000);
    expect(sidecar.getTotalOutputTokens()).toBe(1500);
    expect(sidecar.getTotalCostUsd()).toBeGreaterThan(0);
  });

  test("turn_complete increments turn count for active model", () => {
    const sidecar = new CostSidecar();
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: { type: "turn_context", payload: {
        cwd: "/",
        approvalPolicy: "never",
        sandboxPolicy: "read_only",
        model: "grok-4-fast",
      } },
    });
    sidecar.onEvent({
      id: "2",
      seq: 2,
      msg: {
        type: "token_count",
        payload: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });
    sidecar.onEvent({
      id: "3",
      seq: 3,
      msg: {
        type: "turn_complete",
        payload: { turnId: "t1" },
      },
    });
    expect(sidecar.getTotalTurns()).toBe(1);
  });

  test("formatSummary produces one-line output", () => {
    const sidecar = new CostSidecar();
    const line = sidecar.formatSummary();
    expect(line).toContain("turns=0");
  });
});
