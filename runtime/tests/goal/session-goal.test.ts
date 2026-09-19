import { expect, test, vi } from "vitest";

import { GOAL_INTEGRITY_CONSTRAINT, type SessionGoal } from "../../src/goal/goal.js";
import { commitSessionGoal, getSessionGoal, goalFromRolloutItems, restoreSessionGoal } from "../../src/goal/session-goal.js";

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    id: "g", objective: "tests pass", verification: [{ label: "tests", script: "npm test" }], criteria: [],
    constraints: [GOAL_INTEGRITY_CONSTRAINT], budget: { maxRounds: 20 }, status: "active", rounds: 0, stalledRounds: 0,
    startedAt: "2026-09-19T00:00:00.000Z", startCostUsd: 0, ...overrides,
  };
}
function session() {
  let n = 0;
  return { emit: vi.fn(), nextInternalSubId: () => `sub-${(n += 1)}` };
}
const item = (g: SessionGoal) => ({ type: "event_msg", payload: { msg: { type: "goal_changed", payload: { goal: g, cause: "round" } } } });

test("commit stores the goal and journals the full snapshot durably", () => {
  const s = session();
  commitSessionGoal(s, goal({ rounds: 2 }), "round", "turn-1");
  expect(getSessionGoal(s)).toMatchObject({ rounds: 2 });
  expect(s.emit).toHaveBeenCalledWith(
    { id: "sub-1", msg: { type: "goal_changed", payload: { goal: expect.objectContaining({ objective: "tests pass", rounds: 2 }), cause: "round", turnId: "turn-1" } } },
    { durable: true },
  );
});

test("clearing journals the cleared snapshot and drops the goal", () => {
  const s = session();
  commitSessionGoal(s, goal(), "set");
  commitSessionGoal(s, goal({ status: "cleared" }), "cleared");
  expect(getSessionGoal(s)).toBeUndefined();
  expect(s.emit).toHaveBeenLastCalledWith(expect.objectContaining({ msg: expect.objectContaining({ payload: expect.objectContaining({ cause: "cleared" }) }) }), { durable: true });
});

test("goals are per session and restore does not journal", () => {
  const a = session(); const b = session();
  restoreSessionGoal(a, goal({ rounds: 4 }));
  expect(getSessionGoal(a)).toMatchObject({ rounds: 4 });
  expect(getSessionGoal(b)).toBeUndefined();
  expect(a.emit).not.toHaveBeenCalled();
});

test("a reopened session gets the last open goal back paused, never a finished one", () => {
  expect(goalFromRolloutItems([item(goal({ rounds: 1 })), { type: "other" }, item(goal({ rounds: 3 }))])).toMatchObject({
    rounds: 3, status: "paused", pauseReason: "the session was reopened",
  });
  expect(goalFromRolloutItems([item(goal({ status: "stalled", rounds: 2 }))])).toMatchObject({ status: "stalled" });
  for (const status of ["met", "impossible", "cleared"] as const) {
    expect(goalFromRolloutItems([item(goal()), item(goal({ status }))])).toBeUndefined();
  }
  expect(goalFromRolloutItems([])).toBeUndefined();
});
