import { describe, expect, it } from "vitest";

import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
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

  it("finds a task-scoped client's tool model calls under its own step prefix", async () => {
    const parent = root(kernel(), 5);
    const worker = parent.forSession({ runId: "worker", sessionId: "worker" });
    const task = worker.forSession({ sessionId: "worker", taskId: "task-a" });
    // Stored as task:"task-a":<step id>.
    reconcile(task, await acquire(task, "web_fetch_extraction:worker-sub-1", 0.5), 0.004);
    reconcile(task, await acquire(task, "model:worker-sub-2:1:0:primary", 0.5), 0.25);
    settleTool(task, await acquireTool(task, "tool:worker-turn:call-1", 0.001), 0.001);
    expect(task.getDirectToolCharges?.()?.costUsd).toBeCloseTo(0.005, 12);
    expect(parent.getDirectToolCharges?.()?.costUsd).toBe(0);
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
