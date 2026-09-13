import { describe, expect, it } from "vitest";

import { EVENT_GAP_EVENT } from "../../src/contracts/run-contracts.js";
import type {
  ActiveMessageSubmission,
  ActiveShellExecution,
  BackgroundAgentDaemonEvent,
} from "../../src/app-server/background-agent-runner/shared.js";
import {
  BACKGROUND_RUNNER_GAP_SOURCE,
  boundBufferedAgentEvents,
  managedTokenUsage,
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
