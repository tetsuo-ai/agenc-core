import { describe, expect, it } from "vitest";

import { syncCollabAgentEventToAppState } from "./collabAgentTaskSync.js";
import type { AppState } from "./AppStateStore.js";

function applyEvent(state: AppState, event: unknown): AppState {
  let next = state;
  syncCollabAgentEventToAppState(
    event,
    (updater) => {
      next = updater(next as never) as AppState;
    },
    1234,
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
});
