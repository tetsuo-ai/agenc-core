import { describe, expect, test, vi } from "vitest";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionJournalEvent, AdmissionUsageSummary, AdmissionUsageTotals } from "../../src/budget/admission-types.js";
import type { LiveAgent } from "../../src/agents/control.js";
import { childTerminalOutcome } from "../../src/agents/child-terminal.js";
import { observeChildRoutingAttempt } from "../../src/agents/child-routing-supervisor.js";
import { bindLiveAgentSession } from "../../src/agents/live-session.js";
import { AgentStatusTracker } from "../../src/agents/status.js";
import type { AgentThread } from "../../src/agents/thread.js";
import type { Session } from "../../src/session/session.js";

const usageDefaults: AdmissionUsageTotals = {
  costUsd: 0, heldCostUsd: 0, hasUnknownCost: false,
  modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
};

function journal(sequence: number, overrides: Partial<AdmissionJournalEvent> = {}): AdmissionJournalEvent {
  return { sequence, eventId: `event-${sequence}`, timestamp: "2026-09-29T00:00:00Z",
    runId: "child-1", stepId: `step-${sequence}`, kind: "model_turn", event: "dispatched",
    reservationId: `reservation-${sequence}`, ...overrides };
}

function fixture(options: {
  usage?: Partial<AdmissionUsageTotals> | null;
  events?: readonly AdmissionJournalEvent[];
  bind?: boolean;
} = {}) {
  const status = new AgentStatusTracker();
  const live = { agentId: "child-1", agentPath: "/root/child", status,
    toolCallCount: 0, abortController: new AbortController() } as LiveAgent;
  const events = options.events ?? [journal(1)];
  const replayJournal = vi.fn(({ afterSequence = 0, limit = 256 } = {}) =>
    events.filter((event) => event.sequence > afterSequence).slice(0, limit));
  const admission = { replayJournal } as unknown as ExecutionAdmissionClient;
  const child = { conversationId: live.agentId, abortController: new AbortController(),
    isShuttingDown: false, onBeforeDurableClose: () => () => {},
    services: { executionAdmission: admission } } as unknown as Session;
  let revoke: (() => void) | undefined;
  if (options.bind !== false) revoke = bindLiveAgentSession(live, child);
  const usage = options.usage === null ? undefined : { ...usageDefaults, ...options.usage };
  const summary: AdmissionUsageSummary = { ...usageDefaults, runId: "parent", sequence: 10,
    models: [], agents: usage === undefined ? [] : [{ ...usage, runId: live.agentId }] };
  const parent = { abortController: new AbortController(),
    services: { executionAdmission: { getUsageSummary: () => summary } } } as unknown as Session;
  const unsubscribe = vi.fn();
  const thread = { live, onStatusChange: vi.fn((listener) => {
    const remove = status.subscribe(listener);
    return () => { unsubscribe(); remove(); };
  }) } as unknown as AgentThread;
  const finish = (mode: "idle" | "errored" | "completed" | "interrupted" = "errored",
    dispatch: "sent" | "not_sent" | "unknown" = "sent") => {
    const terminal = childTerminalOutcome({ provider: "deepseek", model: "deepseek-v4-flash",
      reason: mode === "completed" || mode === "idle" ? "completed" : "rate_limited", dispatch });
    live.lastTaskReceipt = { turnId: "turn-1", outcome: mode === "idle" ? "completed" : mode,
      terminal };
    if (mode === "idle") status.markIdle("turn-1", terminal);
    else if (mode === "errored") status.markErrored("turn-1", "rate limited", terminal);
    else if (mode === "completed") status.markCompleted("turn-1", "done", terminal);
    else status.markInterrupted("turn-1", "cancelled", terminal);
  };
  return { live, thread, parent, child, status, replayJournal, unsubscribe, finish,
    revoke: () => revoke?.(), bind: () => { revoke = bindLiveAgentSession(live, child); } };
}

describe("child routing durable attempt observation", () => {
  test("settles keep-alive idle on its durable receipt with exact child spend", async () => {
    const state = fixture({ usage: { costUsd: 0.02 } });
    const observed = observeChildRoutingAttempt(state.parent, state.thread);
    state.status.markRunning("turn-1");
    state.finish("idle");
    expect(await observed).toMatchObject({ value: state.thread, modelCalls: 1, toolCalls: 0,
      costUsd: 0.02, heldUnknownCostUsd: 0, terminal: { reason: "completed" } });
    expect(state.unsubscribe).toHaveBeenCalledOnce();
  });

  test("counts voided rate-limit and funds wire attempts, not usage modelCalls", async () => {
    const state = fixture({ events: [journal(1), journal(2, { event: "voided", reservationId: "reservation-1" }),
      journal(3), journal(4, { event: "dispatched", reservationId: "reservation-3" })] });
    const observed = observeChildRoutingAttempt(state.parent, state.thread);
    state.finish();
    expect((await observed).modelCalls).toBe(2);
  });

  test("paginates admission history and includes final summary calls", async () => {
    const state = fixture({ events: Array.from({ length: 257 }, (_, i) => journal(i + 1,
      i < 256 ? { event: "allowed" } : {})) });
    const observed = observeChildRoutingAttempt(state.parent, state.thread);
    state.finish();
    expect((await observed).modelCalls).toBe(1);
    expect(state.replayJournal).toHaveBeenCalledTimes(2);
  });

  test("attests zero spend for entirely voided 402/429 reservations absent from usage totals", async () => {
    const state = fixture({ usage: null, events: [journal(1),
      journal(2, { event: "voided", reservationId: "reservation-1" })] });
    const observed = observeChildRoutingAttempt(state.parent, state.thread);
    state.finish();
    expect(await observed).toMatchObject({ modelCalls: 1, costUsd: 0 });
  });

  test("captures a newly bound session on the second running notification", async () => {
    const state = fixture({ bind: false });
    const observed = observeChildRoutingAttempt(state.parent, state.thread);
    state.status.markRunning("turn-1");
    state.bind();
    state.status.markRunning("turn-1");
    state.revoke();
    state.finish();
    expect((await observed).modelCalls).toBe(1);
  });

  test("ignores the early interrupt until the durable receipt and retains revoked admission", async () => {
    const state = fixture({ usage: { hasUnknownCost: true, costUsd: 0.01, heldCostUsd: 0.1 } });
    const observed = observeChildRoutingAttempt(state.parent, state.thread);
    state.status.markRunning("turn-1");
    state.live.abortController.abort();
    state.status.markInterrupted("turn-1", "cancelled");
    expect(state.unsubscribe).not.toHaveBeenCalled();
    state.finish("interrupted", "unknown");
    expect(await observed).toMatchObject({ modelCalls: 1, costUsd: 0.01, heldUnknownCostUsd: 0.1 });
  });

  test("returns every observed tool so the fallback supervisor can refuse replay", async () => {
    const state = fixture();
    const observed = observeChildRoutingAttempt(state.parent, state.thread);
    state.live.toolCallCount = 2;
    state.finish();
    expect((await observed).toolCalls).toBe(2);
  });

  test("accepts a preconstruction not-sent receipt with no admission usage", async () => {
    const state = fixture({ bind: false, usage: null });
    state.finish("errored", "not_sent");
    const result = await observeChildRoutingAttempt(state.parent, state.thread);
    expect(result).toMatchObject({ modelCalls: 0, costUsd: 0 });
    expect(state.unsubscribe).toHaveBeenCalledOnce();
  });

  test.each(["shutdown", "completed", "errored"] as const)("refuses %s without a durable receipt", async (mode) => {
    const state = fixture();
    const observed = observeChildRoutingAttempt(state.parent, state.thread);
    if (mode === "shutdown") state.status.markShutdown();
    else if (mode === "completed") state.status.markCompleted("turn-1");
    else state.status.markErrored("turn-1", "durability failed");
    await expect(observed).rejects.toThrow("durable task receipt");
    expect(state.unsubscribe).toHaveBeenCalledOnce();
  });

  test.each([null, { hasUnknownCost: true, heldCostUsd: 0 }] as const)("refuses unaccounted cost: %j", async (usage) => {
    const state = fixture({ usage });
    const observed = observeChildRoutingAttempt(state.parent, state.thread);
    state.finish();
    await expect(observed).rejects.toThrow("cost reservations");
  });

  test("refuses a sent attempt after its binding was already revoked", async () => {
    const state = fixture({ bind: false });
    state.finish();
    await expect(observeChildRoutingAttempt(state.parent, state.thread)).rejects.toThrow("dispatched model calls");
    expect(state.unsubscribe).toHaveBeenCalledOnce();
  });

  test("refuses a journal from a different run", async () => {
    const state = fixture({ events: [journal(1, { runId: "another-child" })] });
    const observed = observeChildRoutingAttempt(state.parent, state.thread);
    state.finish();
    await expect(observed).rejects.toThrow("invalid admission journal");
  });

  test("refuses a receipt for a different assignment", async () => {
    const state = fixture();
    const observed = observeChildRoutingAttempt(state.parent, state.thread);
    state.status.markRunning("turn-2");
    state.finish();
    await expect(observed).rejects.toThrow("initial task changed");
  });

  test.each([true, false])("cleans up on parent cancellation, initially aborted=%s", async (initial) => {
    const state = fixture();
    if (initial) state.parent.abortController.abort();
    const observed = observeChildRoutingAttempt(state.parent, state.thread);
    if (!initial) state.parent.abortController.abort();
    await expect(observed).rejects.toMatchObject({ name: "AbortError" });
    expect(state.unsubscribe).toHaveBeenCalledTimes(initial ? 0 : 1);
  });
});
