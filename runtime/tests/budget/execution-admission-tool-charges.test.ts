import { describe, expect, it } from "vitest";

import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import { type AdmissionLease, isToolModelCallStep } from "../../src/budget/admission-types.js";
import { acquire, kernel, reconcile, root } from "./child-budget.fixture.js";

function acquireTool(client: ExecutionAdmissionClient, stepId: string, cost: number | null) {
  return client.acquire({ stepId, kind: "tool_exec", maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: cost });
}

function settleTool(client: ExecutionAdmissionClient, lease: AdmissionLease, cost: number): void {
  client.markDispatched(lease.reservation.reservationId, { boundary: "tool_effect" });
  client.reconcile(lease.reservation.reservationId, { inputTokens: 0, outputTokens: 0, costUsd: cost });
  client.acknowledgeCompletion(lease.reservation.reservationId);
}

describe("a run's own tool charges", () => {
  it("adds tool fees and the model calls tools made, and nothing else", async () => {
    const parent = root(kernel(), 5);
    expect(parent.getDirectToolCharges?.()).toEqual({ costUsd: 0 });

    // Tool fees: a DeepSeek search and an Ollama fetch.
    settleTool(parent, await acquireTool(parent, "tool:turn-1:call-search", 0.00075), 0.00075);
    settleTool(parent, await acquireTool(parent, "tool:turn-1:call-fetch", 0.001), 0.001);
    // A free local tool call.
    settleTool(parent, await acquireTool(parent, "tool:turn-1:call-read", 0), 0);
    // Model calls tools made for the session.
    reconcile(parent, await acquire(parent, "web_fetch_extraction:sub-1", 0.02), 0.002);
    reconcile(parent, await acquire(parent, "web_search:sub-2", 0.03), 0.003);
    reconcile(parent, await acquire(parent, "x_search:sub-3", 0.04), 0.004);
    // Not tool charges: the turn's own model call, a compaction, a lookalike
    // step id, and a call that was never dispatched.
    reconcile(parent, await acquire(parent, "turn-1:primary", 1), 0.5);
    reconcile(parent, await acquire(parent, "compact:attempt-1:1", 1), 0.25);
    reconcile(parent, await acquire(parent, "web_searches:sub-4", 1), 0.125);
    const voided = await acquireTool(parent, "tool:turn-1:call-voided", 0.5);
    parent.void(voided.reservation.reservationId, "tool_cancelled_before_dispatch");
    parent.acknowledgeCompletion(voided.reservation.reservationId);
    // A sub-agent's tool fee and tool-made call belong to its own run.
    const child = parent.forSession({ runId: "child", sessionId: "child" });
    settleTool(child, await acquireTool(child, "tool:child-turn:call-search", 0.00075), 0.00075);
    reconcile(child, await acquire(child, "web_search:child-sub-1", 0.5), 0.0625);

    expect(parent.getDirectToolCharges?.()?.costUsd).toBeCloseTo(0.00075 + 0.001 + 0.002 + 0.003 + 0.004, 12);
    expect(child.getDirectToolCharges?.()?.costUsd).toBeCloseTo(0.00075 + 0.0625, 12);
  });

  it("counts a task's tool model calls in the task's and its owning run's totals, once each", async () => {
    const parent = root(kernel(), 5);
    const worker = parent.forSession({ runId: "worker", sessionId: "worker" });
    // A second sub-agent whose run and session id extend the first one's.
    const sibling = parent.forSession({ runId: "worker-2", sessionId: "worker-2" });
    const task = worker.forSession({ sessionId: "worker", taskId: "task-a" });
    const laterTask = worker.forSession({ sessionId: "worker", taskId: "task-a2" });
    const siblingTask = sibling.forSession({ sessionId: "worker-2", taskId: "task-a" });

    // Stored as task:"task-a":<step id>.
    reconcile(task, await acquire(task, "web_fetch_extraction:worker-sub-1", 0.5), 0.004);
    reconcile(task, await acquire(task, "model:worker-sub-2:1:0:primary", 0.5), 0.25);
    settleTool(task, await acquireTool(task, "tool:worker-turn:call-1", 0.001), 0.001);
    reconcile(laterTask, await acquire(laterTask, "web_search:worker-sub-3", 0.5), 0.002);
    // The worker run's own calls outside any task.
    reconcile(worker, await acquire(worker, "x_search:worker-sub-4", 0.5), 0.008);
    settleTool(worker, await acquireTool(worker, "tool:worker-turn:call-2", 0.0005), 0.0005);
    reconcile(worker, await acquire(worker, "worker-turn:primary", 1), 0.5);
    // The sibling's charges are its own.
    reconcile(siblingTask, await acquire(siblingTask, "web_fetch_extraction:worker-2-sub-1", 0.5), 0.016);
    settleTool(siblingTask, await acquireTool(siblingTask, "tool:worker-2-turn:call-1", 0.032), 0.032);
    reconcile(sibling, await acquire(sibling, "web_search:worker-2-sub-2", 0.5), 0.064);

    expect(task.getDirectToolCharges?.()?.costUsd).toBeCloseTo(0.004 + 0.001, 12);
    expect(laterTask.getDirectToolCharges?.()?.costUsd).toBeCloseTo(0.002, 12);
    // The owning run: its tasks' calls and its own, each once.
    expect(worker.getDirectToolCharges?.()?.costUsd).toBeCloseTo(0.004 + 0.001 + 0.002 + 0.008 + 0.0005, 12);
    expect(siblingTask.getDirectToolCharges?.()?.costUsd).toBeCloseTo(0.016 + 0.032, 12);
    expect(sibling.getDirectToolCharges?.()?.costUsd).toBeCloseTo(0.016 + 0.032 + 0.064, 12);
    // Delegated runs are not the root's own.
    expect(parent.getDirectToolCharges?.()?.costUsd).toBe(0);
  });

  it("encodes same-run session ids so colons cannot move a step's purpose", async () => {
    const parent = root(kernel(), 5);
    const worker = parent.forSession({ runId: "worker", sessionId: "worker" });
    // Same-run clients for other sessions, ids with colons and quotes.
    const slot = worker.forSession({ sessionId: "worker:slot" });
    const lookalike = worker.forSession({ sessionId: "worker:web_search" });
    const nested = slot.forSession({ sessionId: 'inner "q":1' });
    const task = worker.forSession({ sessionId: "worker", taskId: "task:a" });
    const taskSlot = task.forSession({ sessionId: "slot:1" });

    const slotSearch = await acquire(slot, "web_search:sub-1", 0.5);
    expect(slotSearch.reservation.step.stepId).toBe('session:"worker:slot":web_search:sub-1');
    reconcile(slot, slotSearch, 0.004);
    // A primary model call whose session id holds a purpose's text.
    const lookalikeTurn = await acquire(lookalike, "model:sub-2:primary", 0.5);
    expect(lookalikeTurn.reservation.step.stepId).toBe('session:"worker:web_search":model:sub-2:primary');
    reconcile(lookalike, lookalikeTurn, 0.25);
    const nestedFetch = await acquire(nested, "web_fetch_extraction:sub-3", 0.5);
    expect(nestedFetch.reservation.step.stepId)
      .toBe('session:"worker:slot":session:"inner \\"q\\":1":web_fetch_extraction:sub-3');
    reconcile(nested, nestedFetch, 0.001);
    const taskSearch = await acquire(taskSlot, "x_search:sub-4", 0.5);
    expect(taskSearch.reservation.step.stepId).toBe('task:"task:a":session:"slot:1":x_search:sub-4');
    reconcile(taskSlot, taskSearch, 0.002);

    // The run counts each tool model call once and no session's own call.
    expect(worker.getDirectToolCharges?.()?.costUsd).toBeCloseTo(0.004 + 0.001 + 0.002, 12);
    expect(task.getDirectToolCharges?.()?.costUsd).toBeCloseTo(0.002, 12);
  });

  it("adds nothing for a call still running or a charge the tool never priced", async () => {
    // Uncapped: a hard cost cap refuses an unpriced call before it runs.
    const parent = root(kernel());
    settleTool(parent, await acquireTool(parent, "tool:turn-1:call-search", 0.00075), 0.00075);
    const running = await acquireTool(parent, "tool:turn-1:call-running", 0.001);
    parent.markDispatched(running.reservation.reservationId, { boundary: "tool_effect" });
    const unpriced = await acquireTool(parent, "tool:turn-1:call-endpoint-search", null);
    parent.markDispatched(unpriced.reservation.reservationId, { boundary: "tool_effect" });
    parent.holdUnknown(unpriced.reservation.reservationId, "missing_tool_usage");
    expect(parent.getDirectToolCharges?.()?.costUsd).toBeCloseTo(0.00075, 12);
  });
});

describe("isToolModelCallStep", () => {
  const task = (id: string) => `task:${JSON.stringify(id)}:`;
  // How forSession writes a same-run session's prefix.
  const session = (id: string) => `session:${JSON.stringify(id)}:`;

  it.each([
    "web_fetch_extraction:sub-1",
    "web_search:sub-2",
    "x_search:sub-3",
    `${task("task-a")}web_fetch_extraction:sub-1`,
    `${task('quoted "id": with colons')}x_search:sub-2`,
    `${task("back\\slash")}web_search:sub-3`,
    // Session ids holding colons, quotes or a purpose's text.
    `${session("worker:slot")}web_search:sub-4`,
    `${session('say "hi": twice')}x_search:sub-5`,
    `${session("web_search:")}web_fetch_extraction:sub-6`,
    // Under a task prefix, and nested.
    `${task("task:a")}${session("worker:slot")}x_search:sub-7`,
    `${session("outer:1")}${session("inner:2")}web_fetch_extraction:sub-8`,
    `${task("task-a")}${session("a:b")}${session('c "d"')}web_search:sub-9`,
    // A row written before session ids were encoded: best effort.
    "session:helper:web_search:sub-10",
    `${task("task-a")}session:helper:session:inner:web_fetch_extraction:sub-11`,
  ])("counts %s", (stepId) => {
    expect(isToolModelCallStep(stepId)).toBe(true);
  });

  it.each([
    "turn-1:primary",
    "model:worker-sub-2:1:0:primary",
    "compact:attempt-1:1",
    "web_searches:sub-4",
    "tool:turn-1:call-search",
    "tool:turn-1:web_search:call-1",
    `${task("task-a")}turn-1:primary`,
    `${task("web_search:")}model:sub-1:primary`,
    'task:"unterminated web_search:sub-1',
    'task:"task-a"web_search:sub-1',
    "session:web_search",
    "xweb_search:sub-1",
    // A session's own model call, whatever its id holds.
    `${session("worker:web_search")}model:sub-1:primary`,
    `${session("x_search:")}turn-1:primary`,
    `${task("task-a")}${session("slot:web_fetch_extraction")}model:sub-2:primary`,
    `${session("outer:1")}${session("inner:web_search")}model:sub-3:primary`,
    'session:"unterminated web_search:sub-4',
    'session:"worker"web_search:sub-5',
  ])("does not count %s", (stepId) => {
    expect(isToolModelCallStep(stepId)).toBe(false);
  });
});
