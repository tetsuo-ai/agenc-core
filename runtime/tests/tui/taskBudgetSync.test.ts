import { expect, it } from "vitest";
import { syncTaskBudgetEventToTuiSession } from "../../src/tui/state/taskBudgetSync.js";
import { sessionTaskTokenBudget } from "../../src/config/task-budget.js";

it("mirrors Remove and clear acceptance without mutating the saved config snapshot", () => {
  const saved = Object.freeze({ task_token_budget: 5000 });
  const session: { config: { task_token_budget?: number; taskTokenBudget?: number } } = { config: saved };
  const event = (tokens: number) => ({ type: "warning", payload: { cause: "task_budget_changed", details: { taskTokenBudget: tokens } } });
  syncTaskBudgetEventToTuiSession(event(0), session);
  expect(sessionTaskTokenBudget(session.config)).toBe(0);
  expect(saved.task_token_budget).toBe(5000);
  syncTaskBudgetEventToTuiSession({ msg: event(5000) }, session);
  expect(sessionTaskTokenBudget(session.config)).toBe(5000);
});

it("ignores unrelated and invalid allowance events", () => {
  const config = Object.freeze({ task_token_budget: 5000 });
  const session = { config };
  for (const tokens of [-1, 1.5, "0", null]) syncTaskBudgetEventToTuiSession({ type: "warning", payload: { cause: "task_budget_changed", details: { taskTokenBudget: tokens } } }, session);
  syncTaskBudgetEventToTuiSession({ type: "warning", payload: { cause: "task_budget_near_limit", details: { taskTokenBudget: 0 } } }, session);
  expect(session.config).toBe(config);
});
