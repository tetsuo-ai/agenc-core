import { describe, expect, test } from "vitest";

import { BudgetTracker } from "../llm/token-budget.js";
import { UsageNoticeSidecar } from "./usage-notices.js";
import type { CostSidecar } from "./cost.js";

describe("UsageNoticeSidecar", () => {
  test("tracks total and last token usage from token_count events", () => {
    const sidecar = new UsageNoticeSidecar();

    sidecar.onEvent({
      id: "1",
      msg: {
        type: "token_count",
        payload: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          cachedInputTokens: 5,
          reasoningOutputTokens: 3,
        },
      },
    });
    sidecar.onEvent({
      id: "2",
      msg: {
        type: "token_count",
        payload: {
          promptTokens: 50,
          completionTokens: 10,
          totalTokens: 60,
          cachedInputTokens: 2,
          reasoningOutputTokens: 1,
        },
      },
    });

    expect(sidecar.getLastUsage()).toEqual({
      promptTokens: 50,
      completionTokens: 10,
      totalTokens: 60,
      cachedInputTokens: 2,
      reasoningOutputTokens: 1,
    });
    expect(sidecar.getTotalUsage()).toEqual({
      promptTokens: 150,
      completionTokens: 30,
      totalTokens: 180,
      cachedInputTokens: 7,
      reasoningOutputTokens: 4,
    });
  });

  test("builds context, output, cost, and compaction snapshots", () => {
    const sidecar = new UsageNoticeSidecar();
    sidecar.onEvent({
      id: "turn",
      msg: {
        type: "turn_started",
        payload: {
          turnId: "t1",
          modelContextWindow: 1_000,
        },
      },
    });
    sidecar.onEvent({
      id: "usage",
      msg: {
        type: "token_count",
        payload: {
          promptTokens: 300,
          completionTokens: 100,
          totalTokens: 400,
          reasoningOutputTokens: 25,
        },
      },
    });

    const tracker = new BudgetTracker(1_000);
    tracker.addEmitted(150);
    const costSidecar = {
      getTotalCostUsd: () => 2.5,
    } as CostSidecar;

    expect(
      sidecar.snapshot({
        contextTokenEstimate: 700,
        autoCompactTokenLimit: 800,
        budgetTracker: tracker,
        costSidecar,
        maxBudgetUsd: 10,
      }),
    ).toEqual({
      context: {
        usedTokens: 700,
        totalTokens: 1_000,
        remainingTokens: 300,
        percentUsed: 70,
      },
      output: {
        turnTokens: 150,
        sessionTokens: 125,
        budgetTokens: 1_000,
      },
      costBudget: {
        usedUsd: 2.5,
        totalUsd: 10,
        remainingUsd: 7.5,
        percentUsed: 25,
      },
      compaction: {
        usedTokens: 700,
        thresholdTokens: 800,
        remainingTokens: 100,
        percentUsed: 88,
      },
    });
  });

  test("reset clears usage counters but keeps later events working", () => {
    const sidecar = new UsageNoticeSidecar();
    sidecar.onEvent({
      id: "usage-1",
      msg: {
        type: "token_count",
        payload: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        },
      },
    });
    sidecar.reset();
    expect(sidecar.getTotalUsage().totalTokens).toBe(0);

    sidecar.onEvent({
      id: "usage-2",
      msg: {
        type: "token_count",
        payload: {
          promptTokens: 4,
          completionTokens: 2,
          totalTokens: 6,
        },
      },
    });
    expect(sidecar.getTotalUsage().totalTokens).toBe(6);
  });
});

