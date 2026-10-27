import { expect, it, vi } from "vitest";
import { mkSession } from "../fixtures.js";
import { continueInteractiveTaskBudget, prepareInteractiveTaskBudgetCall, setSessionTaskTokenBudget, taskBudgetOf } from "../../src/session/task-budget.js";

it("pauses without changing history, continues by one allowance, then asks again", async () => {
  const { session, events } = mkSession();
  Object.assign(session.services, { runtimeOptions: { ...session.services.runtimeOptions, interactiveTaskBudget: true } });
  Object.assign(session.config, { taskTokenBudget: 100 });
  const request = vi.spyOn(session, "requestUserInput").mockResolvedValue({ answers: { task_budget: { answers: ["Continue"] } } });
  const budget = taskBudgetOf(session)!; budget.tokens = 100;
  const history = session.snapshotHistoryMessages();
  budget.tokens = 80;
  expect(await continueInteractiveTaskBudget(session)).toBe(true);
  expect(await continueInteractiveTaskBudget(session)).toBe(true);
  expect(events.filter(event => event.msg.type === "warning")).toHaveLength(1);
  expect(request).not.toHaveBeenCalled();
  budget.tokens = 100;
  expect(await continueInteractiveTaskBudget(session)).toBe(true);
  expect(budget.limit).toBe(200);
  expect(budget.tokens).toBe(100);
  expect(session.snapshotHistoryMessages()).toEqual(history);
  budget.tokens = 200;
  expect(await continueInteractiveTaskBudget(session)).toBe(true);
  expect(budget.limit).toBe(300);
  expect(request).toHaveBeenCalledTimes(2);
});
it("removes the limit for this task, and Stop does not extend it", async () => {
  const { session } = mkSession(); Object.assign(session.services, { runtimeOptions: { ...session.services.runtimeOptions, interactiveTaskBudget: true } });
  Object.assign(session.config, { taskTokenBudget: 100 });
  const budget = taskBudgetOf(session)!; budget.tokens = 100;
  const request = vi.spyOn(session, "requestUserInput").mockResolvedValueOnce({ answers: { task_budget: { answers: ["Stop here"] } } });
  expect(await continueInteractiveTaskBudget(session)).toBe(false);
  expect(budget.limit).toBe(100);
  expect(await continueInteractiveTaskBudget(session)).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
  setSessionTaskTokenBudget(session, 100);
  request.mockResolvedValueOnce({ answers: { task_budget: { answers: ["Remove the limit for this task"] } } });
  expect(await continueInteractiveTaskBudget(session)).toBe(true);
  expect(budget.limit).toBeUndefined();
  expect(await continueInteractiveTaskBudget(session)).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});
it("finishes a declined pre-admission checkpoint without asking again during cleanup", async () => {
  const { session } = mkSession();
  Object.assign(session.services, { runtimeOptions: { ...session.services.runtimeOptions, interactiveTaskBudget: true } });
  Object.assign(session.config, { taskTokenBudget: 100 });
  const request = vi.spyOn(session, "requestUserInput").mockResolvedValue({ answers: { task_budget: { answers: ["Stop here"] } } });
  await expect(prepareInteractiveTaskBudgetCall(session, 101)).rejects.toThrow("Task budget reached");
  expect(await continueInteractiveTaskBudget(session)).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
  expect(taskBudgetOf(session)!.tokens).toBe(0);
  setSessionTaskTokenBudget(session, 200);
  expect(await continueInteractiveTaskBudget(session)).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
});
it("headless and routine work keep a hard cap with no question", async () => {
  for (const runtimeOptions of [{ nonInteractive: true }, { routineRun: true }]) {
    const { session } = mkSession(); Object.assign(session.services, { runtimeOptions: { ...session.services.runtimeOptions, interactiveTaskBudget: true } });
  Object.assign(session.config, { taskTokenBudget: 100 });
    session.services.runtimeOptions = { ...session.services.runtimeOptions, ...runtimeOptions } as never;
    taskBudgetOf(session)!.tokens = 100;
    const request = vi.spyOn(session, "requestUserInput");
    expect(await continueInteractiveTaskBudget(session)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  }
});

it("does not let the checkpoint bypass an independent model-call limit", async () => {
  const { session } = mkSession(); Object.assign(session.services, { runtimeOptions: { ...session.services.runtimeOptions, interactiveTaskBudget: true } });
  Object.assign(session.config, { taskTokenBudget: 0, taskMaxCalls: 1 });
  taskBudgetOf(session)!.calls = 1;
  const request = vi.spyOn(session, "requestUserInput");
  expect(await continueInteractiveTaskBudget(session)).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
