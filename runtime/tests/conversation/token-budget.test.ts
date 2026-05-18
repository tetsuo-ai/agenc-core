import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  BudgetTracker,
  checkTokenBudget,
  createBudgetTracker,
  findTokenBudgetPositions,
  getBudgetContinuationMessage,
  getTokenBudgetPromptSection,
  parseTokenBudget,
} from "./token-budget.js";

describe("token budget parsing", () => {
  test("parses shorthand and verbose token targets", () => {
    expect(parseTokenBudget("+500k do this")).toBe(500_000);
    expect(parseTokenBudget("please keep going +1.5m")).toBe(1_500_000);
    expect(parseTokenBudget("spend 2M tokens exploring")).toBe(2_000_000);
    expect(parseTokenBudget("use 1B tokens")).toBe(1_000_000_000);
    expect(parseTokenBudget("use two million tokens")).toBeNull();
  });

  test("finds budget marker positions without double-counting bare shorthand", () => {
    expect(findTokenBudgetPositions("+500k")).toEqual([{ start: 0, end: 5 }]);
    expect(findTokenBudgetPositions("do it +1.5m.")).toEqual([
      { start: 6, end: 12 },
    ]);
    expect(findTokenBudgetPositions("use 2m tokens, then spend 3k tokens")).toEqual([
      { start: 0, end: 13 },
      { start: 20, end: 35 },
    ]);
  });
});

describe("token budget prompt text", () => {
  test("returns the shared prompt assembly section", () => {
    const section = getTokenBudgetPromptSection();

    expect(section).toContain("+500k");
    expect(section).toContain("spend 2M tokens");
    expect(section).toContain("hard minimum");
    expect(section).toContain("automatically continue");
  });

  test("formats continuation messages with token counts", () => {
    expect(getBudgetContinuationMessage(40, 1_234, 10_000)).toBe(
      "Stopped at 40% of token target (1,234 / 10,000). Keep working — do not summarize.",
    );
  });

  test("copied system prompt path uses the shared prompt section", () => {
    const source = readFileSync(
      new URL("../constants/prompts.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("getTokenBudgetPromptSection");
    expect(source).toContain("'token_budget'");
    expect(source).toContain("() => getTokenBudgetPromptSection()");
  });
});

describe("legacy query-loop budget decisions", () => {
  test("createBudgetTracker without a budget returns a tracker for query-loop checks", () => {
    const tracker = createBudgetTracker();

    expect(tracker).toBeInstanceOf(BudgetTracker);
    expect(tracker.budget).toBeNull();
  });

  test("total-budget-aware factory rejects null, invalid, and nonpositive budgets", () => {
    expect(createBudgetTracker(null)).toBeNull();
    expect(createBudgetTracker(Number.NaN)).toBeNull();
    expect(createBudgetTracker(0)).toBeNull();
    expect(createBudgetTracker(-1)).toBeNull();
    expect(createBudgetTracker(1_000)).toBeInstanceOf(BudgetTracker);
  });

  test("stops when an agent or missing budget owns the turn", () => {
    const tracker = createBudgetTracker();

    expect(checkTokenBudget(tracker, "agent-1", 1_000, 100)).toEqual({
      action: "stop",
      completionEvent: null,
    });
    expect(checkTokenBudget(tracker, undefined, null, 100)).toEqual({
      action: "stop",
      completionEvent: null,
    });
    expect(checkTokenBudget(tracker, undefined, 0, 100)).toEqual({
      action: "stop",
      completionEvent: null,
    });
  });

  test("continues below the completion threshold", () => {
    const tracker = createBudgetTracker();

    const decision = checkTokenBudget(tracker, undefined, 1_000, 400);

    expect(decision.action).toBe("continue");
    if (decision.action === "continue") {
      expect(decision.continuationCount).toBe(1);
      expect(decision.pct).toBe(40);
      expect(decision.turnTokens).toBe(400);
      expect(decision.nudgeMessage).toBe(
        getBudgetContinuationMessage(40, 400, 1_000),
      );
    }
    expect(tracker.continuationCount).toBe(1);
    expect(tracker.lastGlobalTurnTokens).toBe(400);
  });

  test("stops at or above the completion threshold after a continuation", () => {
    const tracker = createBudgetTracker();
    expect(checkTokenBudget(tracker, undefined, 1_000, 400).action).toBe(
      "continue",
    );

    const decision = checkTokenBudget(tracker, undefined, 1_000, 900);

    expect(decision.action).toBe("stop");
    if (decision.action === "stop") {
      expect(decision.completionEvent?.pct).toBe(90);
      expect(decision.completionEvent?.turnTokens).toBe(900);
      expect(decision.completionEvent?.diminishingReturns).toBe(false);
    }
  });

  test("stops on diminishing returns after repeated continuations", () => {
    const tracker = createBudgetTracker();

    expect(checkTokenBudget(tracker, undefined, 10_000, 100).action).toBe(
      "continue",
    );
    expect(checkTokenBudget(tracker, undefined, 10_000, 200).action).toBe(
      "continue",
    );
    expect(checkTokenBudget(tracker, undefined, 10_000, 300).action).toBe(
      "continue",
    );

    const decision = checkTokenBudget(tracker, undefined, 10_000, 350);

    expect(decision.action).toBe("stop");
    if (decision.action === "stop") {
      expect(decision.completionEvent).not.toBeNull();
      expect(decision.completionEvent?.diminishingReturns).toBe(true);
      expect(decision.completionEvent?.continuationCount).toBe(3);
      expect(decision.completionEvent?.turnTokens).toBe(350);
    }
  });
});

describe("BudgetTracker boundary behavior", () => {
  test("continues below the completion threshold", () => {
    const tracker = new BudgetTracker(1_000);

    const decision = tracker.checkBoundary(400);

    expect(decision.action).toBe("continue");
    if (decision.action === "continue") {
      expect(decision.continuationCount).toBe(1);
      expect(decision.pct).toBe(40);
      expect(decision.nudgeMessage).toBe(
        getBudgetContinuationMessage(40, 400, 1_000),
      );
    }
    expect(tracker.continuationCount).toBe(1);
    expect(tracker.lastGlobalTurnTokens).toBe(400);
  });

  test("stops on diminishing returns after repeated continuations", () => {
    const tracker = new BudgetTracker(10_000);

    expect(tracker.checkBoundary(100).action).toBe("continue");
    expect(tracker.checkBoundary(200).action).toBe("continue");
    expect(tracker.checkBoundary(300).action).toBe("continue");

    const decision = tracker.checkBoundary(350);

    expect(decision.action).toBe("stop");
    if (decision.action === "stop") {
      expect(decision.completionEvent).not.toBeNull();
      expect(decision.completionEvent?.diminishingReturns).toBe(true);
      expect(decision.completionEvent?.continuationCount).toBe(3);
      expect(decision.completionEvent?.turnTokens).toBe(350);
    }
  });

  test("mid-stream sampling is estimation-only and boundary uses provider truth", () => {
    const tracker = new BudgetTracker(1_000, 100);

    tracker.addEmitted(950, "estimate");
    const sample = tracker.sampleMidStream();

    expect(sample.thresholdReached).toBe(true);
    expect(tracker.emitted).toBe(950);

    const turnTokens = tracker.resolveBoundaryTokens(400);
    const decision = tracker.checkBoundary(turnTokens);

    expect(turnTokens).toBe(400);
    expect(decision.action).toBe("continue");
    expect(tracker.emitted).toBe(0);
  });

  test("resetForTurn clears accumulated counters and restarts continuation tracking", () => {
    const tracker = new BudgetTracker(1_000, 100);

    tracker.addEmitted(250, "estimate");
    tracker.sampleMidStream();
    tracker.checkBoundary(400);

    expect(tracker.continuationCount).toBe(1);
    expect(tracker.emitted).toBe(250);

    tracker.resetForTurn();

    expect(tracker.continuationCount).toBe(0);
    expect(tracker.lastDeltaTokens).toBe(0);
    expect(tracker.lastGlobalTurnTokens).toBe(0);
    expect(tracker.emitted).toBe(0);
  });
});
