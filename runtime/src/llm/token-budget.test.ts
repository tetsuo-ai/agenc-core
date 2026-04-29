import { describe, expect, test } from "vitest";
import { BudgetTracker } from "./token-budget.js";
import { getBudgetContinuationMessage } from "../utils/tokenBudget.js";

describe("BudgetTracker", () => {
  test("continues below the upstream completion threshold", () => {
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
