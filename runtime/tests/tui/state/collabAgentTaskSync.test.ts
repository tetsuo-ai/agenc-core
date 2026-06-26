import { describe, expect, it } from "vitest";

import { syncCollabAgentEventToAppState } from "./collabAgentTaskSync.js";
import type { AppState } from "./AppStateStore.js";

function applyEvent(state: AppState, event: unknown, now = 1234): AppState {
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

function baseState(): AppState {
  return {
    tasks: {},
  } as AppState;
}

describe("syncCollabAgentEventToAppState", () => {
  it("creates a backgrounded local-agent task from spawned-agent events", () => {
    const next = applyEvent(baseState(), {
      type: "collab_agent_spawn_end",
      payload: {
        newThreadId: "agent_1",
        newAgentPath: "/root/task_visibility_probe",
        newAgentNickname: "PatchworkGirl",
        newAgentRoleDisplayName: "Default",
        prompt: "sleep for 90 seconds, then report pwd",
        model: "grok-4.3",
        status: { status: "pending_init" },
      },
    });

    expect(next.tasks.agent_1).toMatchObject({
      id: "agent_1",
      type: "local_agent",
      status: "pending",
      description: "PatchworkGirl",
      prompt: "sleep for 90 seconds, then report pwd",
      agentType: "Default",
      model: "grok-4.3",
      isBackgrounded: true,
      startTime: 1234,
      selectedAgent: { name: "PatchworkGirl" },
    });
  });

  it("updates an existing task from interaction and terminal status events", () => {
    const spawned = applyEvent(baseState(), {
      type: "collab_agent_spawn_end",
      payload: {
        newThreadId: "agent_1",
        newAgentNickname: "PatchworkGirl",
        status: { status: "running" },
      },
    });

    const interacted = applyEvent(spawned, {
      type: "collab_agent_interaction_end",
      payload: {
        receiverThreadId: "agent_1",
        prompt: "new input",
        status: { status: "errored", error: "failed tool" },
      },
    });

    expect(interacted.tasks.agent_1).toMatchObject({
      status: "failed",
      description: "PatchworkGirl",
      prompt: "new input",
      error: "failed tool",
      isBackgrounded: true,
      startTime: 1234,
    });
  });

  it("updates existing daemon-backed agent tasks from daemon status events", () => {
    const spawned = applyEvent(baseState(), {
      type: "collab_agent_spawn_end",
      payload: {
        newThreadId: "agent_1",
        newAgentNickname: "Librarian",
        status: { status: "pending_init" },
      },
    });

    const running = applyEvent(spawned, {
      type: "background_agent_status",
      payload: {
        agentId: "agent_1",
        turnId: "turn_1",
        status: "running",
        runStatus: "running",
      },
    });

    const completed = applyEvent(running, {
      type: "background_agent_status",
      payload: {
        agentId: "agent_1",
        turnId: "turn_1",
        status: "idle",
        runStatus: "completed",
        message: "Done",
      },
    });

    expect(running.tasks.agent_1).toMatchObject({
      status: "running",
      description: "Librarian",
    });
    expect(completed.tasks.agent_1).toMatchObject({
      status: "completed",
      description: "Librarian",
      endTime: 1234,
    });
  });

  it("updates spawned agent tasks from live collab status events", () => {
    const spawned = applyEvent(baseState(), {
      type: "collab_agent_spawn_end",
      payload: {
        newThreadId: "agent_1",
        newAgentNickname: "Librarian",
        newAgentRoleDisplayName: "Default",
        prompt: "inspect the queue",
        status: { status: "pending_init" },
      },
    });

    const running = applyEvent(spawned, {
      type: "collab_agent_status",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        threadId: "agent_1",
        agentNickname: "Librarian",
        agentRoleDisplayName: "Default",
        status: "running",
      },
    });

    const completed = applyEvent(running, {
      type: "collab_agent_status",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        threadId: "agent_1",
        status: "completed",
      },
    });

    expect(running.tasks.agent_1).toMatchObject({
      status: "running",
      description: "Librarian",
      agentType: "Default",
    });
    expect(completed.tasks.agent_1).toMatchObject({
      status: "completed",
      description: "Librarian",
      endTime: 1234,
      // now(1234) + PANEL_GRACE_MS(1_800_000) — terminal result-board retention
      evictAfter: 1_801_234,
      notified: true,
    });
  });

  it("keeps terminal retained agent tasks visible until the view releases them", () => {
    const spawned = applyEvent(baseState(), {
      type: "collab_agent_spawn_end",
      payload: {
        newThreadId: "agent_1",
        newAgentNickname: "Librarian",
        status: { status: "running" },
      },
    });
    const retained = {
      ...spawned,
      tasks: {
        ...spawned.tasks,
        agent_1: {
          ...spawned.tasks.agent_1!,
          retain: true,
        },
      },
    };

    const completed = applyEvent(retained, {
      type: "collab_agent_status",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        threadId: "agent_1",
        status: "completed",
      },
    });

    expect(completed.tasks.agent_1).toMatchObject({
      status: "completed",
      retain: true,
      notified: true,
    });
    expect(completed.tasks.agent_1).not.toHaveProperty("evictAfter");
  });

  it("reactivates terminal agents without stale terminal-only metadata", () => {
    const spawned = applyEvent(baseState(), {
      type: "collab_agent_spawn_end",
      payload: {
        newThreadId: "agent_1",
        newAgentNickname: "Librarian",
        status: { status: "running" },
      },
    }, 1_000);
    const completed = applyEvent(spawned, {
      type: "collab_agent_status",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        threadId: "agent_1",
        status: "completed",
      },
    }, 2_000);
    const completedWithResult = {
      ...completed,
      tasks: {
        ...completed.tasks,
        agent_1: {
          ...completed.tasks.agent_1!,
          result: { final: "old result" },
        },
      },
    };

    const runningAgain = applyEvent(completedWithResult, {
      type: "collab_agent_interaction_begin",
      payload: {
        receiverThreadId: "agent_1",
        prompt: "continue investigating",
        receiverAgentRoleDisplayName: "Default",
      },
    }, 40_000);

    expect(runningAgain.tasks.agent_1).toMatchObject({
      status: "running",
      description: "Librarian",
      prompt: "continue investigating",
      agentType: "Default",
      startTime: 1_000,
      notified: false,
    });
    expect(runningAgain.tasks.agent_1).not.toHaveProperty("endTime");
    expect(runningAgain.tasks.agent_1).not.toHaveProperty("evictAfter");
    expect(runningAgain.tasks.agent_1).not.toHaveProperty("result");
  });

  it("updates spawned agents from collab wait completion summaries", () => {
    const firstSpawn = applyEvent(baseState(), {
      type: "collab_agent_spawn_end",
      payload: {
        newThreadId: "agent_1",
        newAgentNickname: "ChromeRider",
        status: { status: "pending_init" },
      },
    });
    const secondSpawn = applyEvent(firstSpawn, {
      type: "collab_agent_spawn_end",
      payload: {
        newThreadId: "agent_2",
        newAgentNickname: "Quickhack",
        status: { status: "pending_init" },
      },
    });

    const completed = applyEvent(secondSpawn, {
      type: "collab_waiting_end",
      payload: {
        agentStatuses: [
          {
            threadId: "agent_1",
            status: { status: "completed", turnId: "turn_1" },
          },
          {
            threadId: "agent_2",
            status: { status: "errored", error: "review failed" },
          },
          {
            threadId: "missing",
            status: { status: "completed", turnId: "turn_3" },
          },
        ],
      },
    });

    expect(completed.tasks.agent_1).toMatchObject({
      status: "completed",
      description: "ChromeRider",
      endTime: 1234,
      // now(1234) + PANEL_GRACE_MS(1_800_000) — terminal result-board retention
      evictAfter: 1_801_234,
      notified: true,
    });
    expect(completed.tasks.agent_2).toMatchObject({
      status: "failed",
      description: "Quickhack",
      error: "review failed",
      endTime: 1234,
      // now(1234) + PANEL_GRACE_MS(1_800_000) — terminal result-board retention
      evictAfter: 1_801_234,
      notified: true,
    });
    expect(completed.tasks.missing).toBeUndefined();
  });

  it("ignores unrelated events", () => {
    const state = baseState();
    const next = applyEvent(state, {
      type: "turn_started",
      payload: { turnId: "turn_1" },
    });

    expect(next).toBe(state);
  });

  it("ignores daemon background status events without inventing agent tasks", () => {
    const state = baseState();
    const next = applyEvent(state, {
      type: "background_agent_status",
      payload: {
        turnId: "turn-completed-54-15550",
        status: "idle",
        message: "The spawned agent id is `/root/task_visibility_probe`.",
      },
    });

    expect(next).toBe(state);
  });

  it("does not invent tasks from daemon status for unknown agent ids", () => {
    const state = baseState();
    const next = applyEvent(state, {
      type: "background_agent_status",
      payload: {
        agentId: "agent_1",
        turnId: "turn_1",
        status: "idle",
        runStatus: "completed",
      },
    });

    expect(next).toBe(state);
  });

  it("does not invent tasks from live collab status for unknown agent ids", () => {
    const state = baseState();
    const next = applyEvent(state, {
      type: "collab_agent_status",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        threadId: "agent_1",
        status: "completed",
      },
    });

    expect(next).toBe(state);
  });
});
