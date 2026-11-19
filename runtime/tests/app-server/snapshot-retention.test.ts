import { describe, expect, it } from "vitest";

import { EVENT_GAP_EVENT } from "../../src/contracts/run-contracts.js";
import { CostSidecar } from "../../src/session/cost.js";
import type {
  ActiveMessageSubmission,
  ActiveShellExecution,
  BackgroundAgentDaemonEvent,
} from "../../src/app-server/background-agent-runner/shared.js";
import {
  BACKGROUND_RUNNER_GAP_SOURCE,
  boundBufferedAgentEvents,
  managedTokenUsage,
  terminalUsageForActiveAgent,
  pruneMessageSubmissionCache,
  pruneShellExecutionCache,
} from "../../src/app-server/background-agent-runner/snapshot-retention.js";

const MAX_BUFFERED_AGENT_EVENTS = 1_000;
const MAX_RETAINED_SHELL_EXECUTIONS = 256;
const MAX_MESSAGE_SUBMISSION_CACHE = 1_024;

function event(
  id: string,
  sequence?: number,
): BackgroundAgentDaemonEvent {
  return {
    id,
    type: "agent_message_delta",
    ...(sequence !== undefined ? { sequence } : {}),
    payload: { delta: id },
  };
}

function gapMarker(
  retiredCount: number,
  extras: Record<string, unknown> = {},
): BackgroundAgentDaemonEvent {
  return {
    id: "runner-gap:prior",
    type: EVENT_GAP_EVENT,
    payload: {
      kind: EVENT_GAP_EVENT,
      reason: "retention",
      source: BACKGROUND_RUNNER_GAP_SOURCE,
      retiredCount,
      ...extras,
    },
  };
}

describe("boundBufferedAgentEvents", () => {
  it("leaves a buffer under the cap untouched and returns the same array", () => {
    const events = [event("a", 1), event("b", 2)];
    expect(boundBufferedAgentEvents(events, "run-1")).toBe(events);
    expect(events).toEqual([event("a", 1), event("b", 2)]);
  });

  it("evicts the oldest real events and records a sequenced gap", () => {
    const events = Array.from({ length: MAX_BUFFERED_AGENT_EVENTS + 100 }, (_, i) =>
      event(`e-${i + 1}`, i + 1),
    );

    boundBufferedAgentEvents(events, "run-1");

    expect(events).toHaveLength(MAX_BUFFERED_AGENT_EVENTS + 1);
    expect(events[0]).toEqual({
      id: "runner-gap:run-1",
      type: EVENT_GAP_EVENT,
      payload: {
        kind: EVENT_GAP_EVENT,
        reason: "retention",
        source: BACKGROUND_RUNNER_GAP_SOURCE,
        retiredCount: 100,
        coordinatesAvailable: true,
        runId: "run-1",
        afterSequence: 0,
        firstAvailableSequence: 101,
      },
    });
    expect(events[1]).toEqual(event("e-101", 101));
    expect(events.at(-1)).toEqual(
      event(`e-${MAX_BUFFERED_AGENT_EVENTS + 100}`, MAX_BUFFERED_AGENT_EVENTS + 100),
    );
  });

  it("accumulates retiredCount across later evictions and keeps the prior afterSequence", () => {
    const events = Array.from({ length: MAX_BUFFERED_AGENT_EVENTS + 50 }, (_, i) =>
      event(`e-${i + 1}`, i + 1),
    );
    boundBufferedAgentEvents(events, "run-1");
    for (let i = 0; i < 25; i++) {
      events.push(event(`late-${i + 1}`, MAX_BUFFERED_AGENT_EVENTS + 51 + i));
    }

    boundBufferedAgentEvents(events);

    expect(events[0]?.payload).toMatchObject({
      retiredCount: 75,
      coordinatesAvailable: true,
      runId: "run-1",
      afterSequence: 0,
      firstAvailableSequence: 76,
    });
  });

  it("marks coordinates unavailable when retired events lack sequences", () => {
    const events = Array.from({ length: MAX_BUFFERED_AGENT_EVENTS + 3 }, (_, i) =>
      event(`e-${i + 1}`),
    );

    boundBufferedAgentEvents(events, "run-1");

    expect(events[0]?.payload).toEqual({
      kind: EVENT_GAP_EVENT,
      reason: "retention",
      source: BACKGROUND_RUNNER_GAP_SOURCE,
      retiredCount: 3,
      coordinatesAvailable: false,
      runId: "run-1",
    });
  });

  it("keeps coordinates unavailable after a prior unknown gap", () => {
    const events = [
      gapMarker(10, { coordinatesAvailable: false, runId: "run-prior" }),
      ...Array.from({ length: MAX_BUFFERED_AGENT_EVENTS + 1 }, (_, i) =>
        event(`e-${i + 1}`, i + 1),
      ),
    ];

    boundBufferedAgentEvents(events);

    expect(events[0]?.payload).toMatchObject({
      retiredCount: 11,
      coordinatesAvailable: false,
      runId: "run-prior",
    });
    expect(events[0]?.payload).not.toHaveProperty("afterSequence");
  });

  it("collapses prior gap markers into one replacement and keeps the real events", () => {
    const events = [
      gapMarker(2, { coordinatesAvailable: false }),
      event("keep-1", 5),
      event("keep-2", 6),
    ];

    boundBufferedAgentEvents(events, "run-1");

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      id: "runner-gap:run-1",
      type: EVENT_GAP_EVENT,
      payload: {
        kind: EVENT_GAP_EVENT,
        reason: "retention",
        source: BACKGROUND_RUNNER_GAP_SOURCE,
        retiredCount: 2,
        coordinatesAvailable: false,
        runId: "run-1",
      },
    });
    expect(events.slice(1)).toEqual([event("keep-1", 5), event("keep-2", 6)]);
  });
});

describe("pruneShellExecutionCache", () => {
  function execution(settled: boolean): ActiveShellExecution {
    return {
      commandFingerprint: "fp",
      promise: Promise.resolve({} as never),
      settled,
    };
  }

  it("does not evict while at or under the cap", () => {
    const cache = new Map<string, ActiveShellExecution>();
    for (let i = 0; i < MAX_RETAINED_SHELL_EXECUTIONS; i++) {
      cache.set(`cmd-${i}`, execution(true));
    }

    pruneShellExecutionCache(cache);

    expect(cache.size).toBe(MAX_RETAINED_SHELL_EXECUTIONS);
  });

  it("drops settled executions first and never deletes an unsettled one", () => {
    const cache = new Map<string, ActiveShellExecution>();
    for (let i = 0; i < MAX_RETAINED_SHELL_EXECUTIONS - 1; i++) {
      cache.set(`live-${i}`, execution(false));
    }
    cache.set("done-a", execution(true));
    cache.set("done-b", execution(true));

    pruneShellExecutionCache(cache);

    expect(cache.size).toBe(MAX_RETAINED_SHELL_EXECUTIONS);
    expect(cache.has("done-a")).toBe(false);
    expect(cache.has("done-b")).toBe(true);
    expect([...cache.keys()].filter((key) => key.startsWith("live-"))).toHaveLength(
      MAX_RETAINED_SHELL_EXECUTIONS - 1,
    );
  });
});

describe("pruneMessageSubmissionCache", () => {
  function submission(settled: boolean): ActiveMessageSubmission {
    return {
      clientMessageId: "msg",
      contentFingerprint: "fp",
      streamId: "stream",
      acceptedAt: "t0",
      assistantMessageOrdinal: 0,
      promise: Promise.resolve({} as never),
      settled,
    };
  }

  it("stops once the cache is back at the cap", () => {
    const cache = new Map<string, ActiveMessageSubmission>();
    for (let i = 0; i < MAX_MESSAGE_SUBMISSION_CACHE + 3; i++) {
      cache.set(`msg-${i}`, submission(true));
    }

    pruneMessageSubmissionCache(cache);

    expect(cache.size).toBe(MAX_MESSAGE_SUBMISSION_CACHE);
    expect(cache.has("msg-0")).toBe(false);
    expect(cache.has("msg-3")).toBe(true);
  });
});

describe("managedTokenUsage", () => {
  it("returns zeros when usage is missing or not an object", () => {
    expect(managedTokenUsage({ totalTokenUsage: () => undefined })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(managedTokenUsage({ totalTokenUsage: () => null })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it("prefers the live-agent field names when both shapes are present", () => {
    expect(
      managedTokenUsage({
        totalTokenUsage: () => ({
          inputTokens: 4,
          promptTokens: 99,
          outputTokens: 2,
          completionTokens: 88,
          totalTokens: 6,
        }),
      }),
    ).toEqual({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
  });

  it("ignores non-finite token fields", () => {
    expect(
      managedTokenUsage({
        totalTokenUsage: () => ({
          inputTokens: Number.NaN,
          promptTokens: 3,
          outputTokens: Number.POSITIVE_INFINITY,
          completionTokens: 1,
          totalTokens: Number.NaN,
        }),
      }),
    ).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 });
  });
});


describe("estimated snapshot cost", () => {
  it("retains per-call fallback costs for an undocumented Fast tier", () => {
    const sidecar = new CostSidecar();
    const live = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 };
    const active = {
      thread: { totalTokenUsage: () => live },
      bootstrap: { session: { services: { costSidecar: sidecar } } },
    } as unknown as Parameters<typeof terminalUsageForActiveAgent>[0];
    const payload = {
      model: "gpt-5.4-pro",
      provider: "openai",
      promptTokens: 1_000,
      completionTokens: 100,
      totalTokens: 1_100,
    };
    sidecar.onEvent({
      id: "fast-usage",
      msg: { type: "token_count", payload: { ...payload, speed: "fast" } },
    });
    expect(terminalUsageForActiveAgent(active)).toEqual({
      ...live,
      costUsd: expect.closeTo(0.21, 9),
      costKnown: true,
      costEstimated: true,
    });

    sidecar.onEvent({
      id: "standard-usage",
      msg: { type: "token_count", payload },
    });
    live.inputTokens *= 2;
    live.outputTokens *= 2;
    live.totalTokens *= 2;
    expect(terminalUsageForActiveAgent(active)).toEqual({
      ...live,
      costUsd: expect.closeTo(0.21 + 0.048, 9),
      costKnown: true,
      costEstimated: true,
    });
  });

  it("labels a complete fallback estimate and does not attest incomplete history", () => {
    const live = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
    const sidecar = { getTotalCostUsd: () => 0.045, getSessionTotals: () => live, hasUnknownModelCost: () => true };
    let reported = live;
    const active = { thread: { totalTokenUsage: () => reported }, bootstrap: { session: { services: {costSidecar: sidecar} } } } as unknown as Parameters<typeof terminalUsageForActiveAgent>[0];
    expect(terminalUsageForActiveAgent(active)).toEqual({...live, costUsd: 0.045, costKnown: true, costEstimated: true});
    reported = {...live, totalTokens: 200};
    expect(terminalUsageForActiveAgent(active)).toMatchObject({costKnown: false, costEstimated: true});
    reported = live;
    sidecar.hasUnknownModelCost = () => false;
    expect(terminalUsageForActiveAgent(active)).toEqual({...live, costUsd: 0.045, costKnown: true});
  });
});

describe("snapshot cost includes the session's tool charges", () => {
  const live = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 };
  function activeWith(services: Record<string, unknown>) {
    return {
      thread: { totalTokenUsage: () => live },
      bootstrap: { session: { services } },
    } as unknown as Parameters<typeof terminalUsageForActiveAgent>[0];
  }
  const sidecar = {
    getTotalCostUsd: () => 0.003,
    getSessionTotals: () => live,
    hasUnknownModelCost: () => false,
  };

  it("adds web search and fetch fees and tool-made model calls to the model cost", () => {
    const usage = terminalUsageForActiveAgent(activeWith({
      costSidecar: sidecar,
      executionAdmission: { getDirectToolCharges: () => ({ costUsd: 0.00225 }) },
    }));
    expect(usage).toEqual({ ...live, costUsd: expect.closeTo(0.00525, 12), costKnown: true });
  });

  it("marks the cost unknown when the tool charges cannot be read", () => {
    expect(terminalUsageForActiveAgent(activeWith({
      costSidecar: sidecar,
      executionAdmission: { getDirectToolCharges: () => { throw new Error("kernel closed"); } },
    }))).toEqual({ ...live, costUsd: 0.003, costKnown: false });
  });

  it("keeps the model cost alone without an admission ledger", () => {
    expect(terminalUsageForActiveAgent(activeWith({ costSidecar: sidecar })))
      .toEqual({ ...live, costUsd: 0.003, costKnown: true });
  });
});

describe("snapshot cost from the admission ledger", () => {
  type Counts = { inputTokens: number; outputTokens: number; totalTokens: number };
  function ledgerSummary(counts: Counts, costUsd: number, extra: Record<string, unknown> = {}) {
    return { runId: "chat", sequence: 7, ...counts, costUsd, modelCalls: 3, hasUnknownCost: false,
      heldCostUsd: 0, models: [], agents: [], ...extra };
  }
  function activeWith(params: {
    readonly live: Counts;
    readonly ledger: () => unknown;
    readonly state?: Record<string, unknown>;
    readonly sidecar?: Record<string, unknown>;
  }) {
    const state = params.state ?? {};
    return {
      thread: { totalTokenUsage: () => params.live },
      bootstrap: { session: {
        state: { unsafePeek: () => state },
        services: {
          executionAdmission: { getDirectUsageSummary: params.ledger },
          ...(params.sidecar !== undefined ? { costSidecar: params.sidecar } : {}),
        },
      } },
    } as unknown as Parameters<typeof terminalUsageForActiveAgent>[0];
  }
  // A cost record saved before the last turns: what cost-totals.json holds
  // after the daemon dies mid-session.
  const shortSidecar = {
    getTotalCostUsd: () => 0.003,
    getSessionTotals: () => ({ inputTokens: 1_200, outputTokens: 40, totalTokens: 1_240 }),
    getRestoredSessionTotals: () => ({ inputTokens: 1_200, outputTokens: 40, totalTokens: 1_240 }),
    hasUnknownModelCost: () => false,
  };

  it("takes a session's cost from its ledger, not the cost sidecar", () => {
    const live = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 };
    expect(terminalUsageForActiveAgent(activeWith({
      live,
      ledger: () => ledgerSummary(live, 0.004),
      sidecar: { getTotalCostUsd: () => 0.003, getSessionTotals: () => live, hasUnknownModelCost: () => false },
    }))).toEqual({ ...live, costUsd: 0.004, costKnown: true });
  });

  it("reports a session revived after a crash whole, with the ledger's cost", () => {
    // Turns before the crash recorded 2,000 / 80 tokens; the saved cost
    // record covers only 1,200 / 40 of them. This process ran 500 / 20 more.
    const live = { inputTokens: 500, outputTokens: 20, totalTokens: 520 };
    const state = {
      initialTokenUsage: { promptTokens: 800, completionTokens: 40, totalTokens: 840 },
      resumedHistoryTokenUsage: { promptTokens: 2_000, completionTokens: 80, totalTokens: 2_080 },
      resumedLedgerUsage: { inputTokens: 2_000, outputTokens: 80, totalTokens: 2_080 },
    };
    expect(terminalUsageForActiveAgent(activeWith({
      live, state, sidecar: shortSidecar,
      ledger: () => ledgerSummary({ inputTokens: 2_500, outputTokens: 100, totalTokens: 2_600 }, 0.0071),
    }))).toEqual({ inputTokens: 2_500, outputTokens: 100, totalTokens: 2_600, costUsd: 0.0071, costKnown: true });
  });

  it("calls the cost unknown when the ledger missed calls the turns reported", () => {
    const live = { inputTokens: 500, outputTokens: 20, totalTokens: 520 };
    const history = { promptTokens: 2_000, completionTokens: 80, totalTokens: 2_080 };
    const whole = { inputTokens: 2_500, outputTokens: 100, totalTokens: 2_600 };
    const usage = (state: Record<string, unknown>, ledger: () => unknown) =>
      terminalUsageForActiveAgent(activeWith({ live, state, ledger }));
    // The run's earlier calls were admitted elsewhere: at the resume the
    // ledger held only part of the recorded history.
    expect(usage(
      { resumedHistoryTokenUsage: history, resumedLedgerUsage: { inputTokens: 1_200, outputTokens: 40, totalTokens: 1_240 } },
      () => ledgerSummary(whole, 0.0071),
    )).toEqual({ ...whole, costUsd: 0.0071, costKnown: false });
    // No ledger reading at the resume.
    expect(usage({ resumedHistoryTokenUsage: history }, () => ledgerSummary(whole, 0.0071)))
      .toMatchObject({ ...whole, costKnown: false });
    // The ledger now holds less than the turns reported.
    expect(usage({}, () => ledgerSummary({ inputTokens: 499, outputTokens: 20, totalTokens: 519 }, 0.001)))
      .toEqual({ ...live, costUsd: 0.001, costKnown: false });
    // A history seeded without its sum cannot be checked.
    expect(usage({ initialTokenUsage: { promptTokens: 9, completionTokens: 1, totalTokens: 10 } },
      () => ledgerSummary(whole, 0.0071))).toEqual({ ...live, costUsd: 0.0071, costKnown: false });
  });

  it("marks an unpriced or estimated call, and a ledger it cannot read", () => {
    const live = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 };
    const usage = (ledger: () => unknown) => terminalUsageForActiveAgent(activeWith({ live, ledger }));
    expect(usage(() => ledgerSummary(live, 0.004, { hasUnknownCost: true })))
      .toEqual({ ...live, costUsd: 0.004, costKnown: false });
    expect(usage(() => ledgerSummary(live, 0.004, { costEstimated: true })))
      .toEqual({ ...live, costUsd: 0.004, costKnown: true, costEstimated: true });
    expect(usage(() => { throw new Error("kernel closed"); }))
      .toEqual({ ...live, costUsd: 0, costKnown: false });
    expect(usage(() => ledgerSummary(live, Number.NaN)))
      .toEqual({ ...live, costUsd: 0, costKnown: false });
  });
});
