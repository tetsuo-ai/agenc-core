import { describe, expect, test, vi } from "vitest";

import { syncCollabAgentEventToAppState } from "./collabAgentTaskSync.js";
import type { AppState } from "./AppStateStore.js";

function applyEvent(state: AppState, event: unknown, now = 5000): AppState {
  let next = state;
  syncCollabAgentEventToAppState(
    event,
    (updater) => {
      next = updater(next as never) as AppState;
    },
    now,
  );
  return next;
}

function applyEventToUnknown(state: unknown, event: unknown): unknown {
  let next = state;
  syncCollabAgentEventToAppState(
    event,
    (updater) => {
      next = updater(next as never);
    },
    5000,
  );
  return next;
}

function baseState(): AppState {
  return {
    tasks: {},
  } as AppState;
}

describe("syncCollabAgentEventToAppState coverage edges", () => {
  test("normalizes fallback statuses and ignores malformed task events", () => {
    const cleanup = vi.fn();
    const abortController = new AbortController();
    const spawned = applyEvent(baseState(), {
      type: "collab_agent_spawn_end",
      payload: {
        newThreadId: "agent/canceled 1",
        status: "canceled",
      },
    });

    expect(spawned.tasks["agent/canceled 1"]).toMatchObject({
      id: "agent/canceled 1",
      status: "killed",
      description: "agent/canceled 1",
      outputFile: "urn:agenc:task:agent%2Fcanceled%201:output",
      endTime: 5000,
      // now(5000) + PANEL_GRACE_MS(1_800_000) — terminal result-board retention
      evictAfter: 1_805_000,
      notified: true,
      selectedAgent: { name: "agent/canceled 1" },
    });

    const seeded = applyEvent(spawned, {
      type: "collab_agent_spawn_end",
      payload: {
        newThreadId: "agent_existing",
        newAgentPath: "  /tmp/fallback-agent  ",
        prompt: "  review the fallback path  ",
        status: 7,
      },
    });
    const withExisting = {
      ...seeded,
      tasks: {
        ...seeded.tasks,
        agent_existing: {
          ...seeded.tasks.agent_existing!,
          abortController,
          diskLoaded: true,
          lastReportedTokenCount: 13,
          lastReportedToolCount: 2,
          messages: [{ role: "assistant", content: "hello" }],
          pendingMessages: ["queued"],
          progress: { toolUseCount: 2, tokenCount: 13 },
          result: { ok: true },
          retrieved: true,
          unregisterCleanup: cleanup,
        },
      },
    } as AppState;

    const failedFromFlatStatus = applyEvent(withExisting, {
      type: "collab_agent_status",
      payload: {
        threadId: "agent_existing",
        status: "failed",
        error: "flat status error",
      },
    });

    expect(failedFromFlatStatus.tasks.agent_existing).toMatchObject({
      status: "failed",
      description: "/tmp/fallback-agent",
      prompt: "review the fallback path",
      error: "flat status error",
      abortController,
      diskLoaded: true,
      lastReportedTokenCount: 13,
      lastReportedToolCount: 2,
      messages: [{ role: "assistant", content: "hello" }],
      pendingMessages: ["queued"],
      progress: { toolUseCount: 2, tokenCount: 13 },
      result: { ok: true },
      retrieved: true,
      unregisterCleanup: cleanup,
    });

    const daemonFailed = applyEvent(failedFromFlatStatus, {
      type: "background_agent_status",
      payload: {
        agentId: "agent_existing",
        runStatus: "errored",
        message: "daemon failed",
      },
    });
    const daemonStopped = applyEvent(daemonFailed, {
      type: "background_agent_status",
      payload: {
        agentId: "agent_existing",
        status: "stopped",
      },
    });
    const daemonIdle = applyEvent(daemonStopped, {
      type: "background_agent_status",
      payload: {
        agentId: "agent_existing",
        status: "idle",
      },
    });

    expect(daemonFailed.tasks.agent_existing).toMatchObject({
      status: "failed",
      error: "daemon failed",
    });
    expect(daemonStopped.tasks.agent_existing).toMatchObject({
      status: "killed",
    });
    expect(daemonIdle.tasks.agent_existing).toMatchObject({
      status: "completed",
    });

    const missingTasks = applyEvent({} as AppState, {
      type: "background_agent_status",
      payload: {
        agentId: "unknown",
        runStatus: "pending",
      },
    });
    expect(missingTasks).toEqual({});

    const malformedEvents = [
      null,
      { type: 7, payload: {} },
      { type: "collab_agent_spawn_end", payload: {} },
      { type: "collab_agent_status", payload: {} },
      { type: "collab_agent_interaction_begin", payload: {} },
      { type: "background_agent_status", payload: {} },
      { type: "collab_waiting_end", payload: { agentStatuses: "nope" } },
      {
        type: "collab_waiting_end",
        payload: { agentStatuses: [null, {}, { threadId: " " }] },
      },
    ];

    for (const event of malformedEvents) {
      expect(applyEvent(daemonIdle, event)).toBe(daemonIdle);
    }

    expect(
      applyEventToUnknown(null, {
        type: "collab_agent_spawn_end",
        payload: { newThreadId: "agent_null", status: "running" },
      }),
    ).toBeNull();
  });
});
