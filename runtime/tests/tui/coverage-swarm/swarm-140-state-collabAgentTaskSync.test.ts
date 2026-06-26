import { describe, expect, test } from "vitest";

import { syncCollabAgentEventToAppState } from "src/tui/state/collabAgentTaskSync.js";

type TestTask = Record<string, unknown>;
type TestState = {
  readonly marker?: string;
  readonly tasks?: Record<string, TestTask>;
};

function applyEvent<T extends TestState>(
  state: T,
  event: unknown,
  now = 10_000,
): T {
  let next: TestState = state;
  syncCollabAgentEventToAppState(
    event,
    (updater) => {
      next = updater(next as never) as TestState;
    },
    now,
  );
  return next as T;
}

function localAgentTask(
  id: string,
  overrides: Record<string, unknown> = {},
): TestTask {
  return {
    id,
    type: "local_agent",
    status: "running",
    description: id,
    startTime: 100,
    outputFile: `urn:agenc:task:${encodeURIComponent(id)}:output`,
    outputOffset: 0,
    notified: false,
    agentId: id,
    prompt: "inspect",
    agentType: "worker",
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    selectedAgent: { name: id },
    ...overrides,
  };
}

function shellTask(id: string): TestTask {
  return {
    id,
    type: "local_bash",
    status: "running",
    description: id,
    startTime: 100,
    outputFile: `urn:agenc:task:${encodeURIComponent(id)}:output`,
    outputOffset: 0,
    notified: false,
    command: "true",
  };
}

describe("collabAgentTaskSync coverage swarm row 140", () => {
  test("creates spawned tasks with trimmed fallback metadata and pending aliases", () => {
    const next = applyEvent(
      { marker: "keep", tasks: {} },
      {
        type: "collab_agent_spawn_end",
        payload: {
          newThreadId: "  agent 140/alpha  ",
          taskName: "  Fallback task title  ",
          prompt: "  summarize the logs  ",
          newAgentRole: "  reviewer  ",
          status: "STARTING",
        },
      },
    );

    expect(next.marker).toBe("keep");
    expect(next.tasks?.["agent 140/alpha"]).toMatchObject({
      id: "agent 140/alpha",
      type: "local_agent",
      status: "pending",
      description: "Fallback task title",
      prompt: "summarize the logs",
      agentType: "reviewer",
      outputFile: "urn:agenc:task:agent%20140%2Falpha:output",
      notified: false,
      selectedAgent: { name: "Fallback task title" },
    });
  });

  test("updates existing live status with path, role, model, and failed aliases", () => {
    const state: TestState = {
      tasks: {
        "agent-140": localAgentTask("agent-140", {
          description: "original",
          prompt: "original prompt",
          agentType: "worker",
        }),
      },
    };

    const next = applyEvent(state, {
      type: "collab_agent_status",
      payload: {
        threadId: "agent-140",
        agentPath: "  /tmp/agent-140  ",
        prompt: "  check failing case  ",
        agentRole: "  fixer  ",
        model: "  model-140  ",
        status: "not_found",
        error: "  missing worker  ",
      },
    });

    expect(next.tasks?.["agent-140"]).toMatchObject({
      status: "failed",
      description: "/tmp/agent-140",
      prompt: "check failing case",
      agentType: "fixer",
      model: "model-140",
      error: "missing worker",
      notified: true,
      endTime: 10_000,
      // now(10_000) + PANEL_GRACE_MS(1_800_000) — terminal result-board retention
      evictAfter: 1_810_000,
    });
  });

  test("starts interaction tasks even when the receiver did not already exist", () => {
    const next = applyEvent(
      { tasks: {} },
      {
        type: "collab_agent_interaction_begin",
        payload: {
          receiverThreadId: "fresh-agent",
          receiverAgentRole: "  helper  ",
          prompt: "  continue work  ",
          status: { status: "running" },
        },
      },
    );

    expect(next.tasks?.["fresh-agent"]).toMatchObject({
      id: "fresh-agent",
      status: "running",
      description: "fresh-agent",
      prompt: "continue work",
      agentType: "helper",
      notified: false,
    });
    expect(next.tasks?.["fresh-agent"]).not.toHaveProperty("error");
  });

  test("normalizes daemon status variants without updating non-agent tasks", () => {
    const shellOnly: TestState = {
      tasks: {
        "shell-140": shellTask("shell-140"),
      },
    };

    expect(
      applyEvent(shellOnly, {
        type: "background_agent_status",
        payload: {
          agentId: "shell-140",
          runStatus: "pending",
        },
      }),
    ).toBe(shellOnly);

    const runStatusCases = [
      ["pending", "pending"],
      ["working", "running"],
      ["paused", "running"],
      ["blocked", "running"],
      ["suspended", "running"],
      ["stopped", "killed"],
    ] as const;

    for (const [runStatus, expected] of runStatusCases) {
      const next = applyEvent(
        { tasks: { worker: localAgentTask("worker") } },
        {
          type: "background_agent_status",
          payload: {
            agentId: "worker",
            runStatus,
          },
        },
      );
      expect(next.tasks?.worker).toMatchObject({ status: expected });
    }

    const statusCases = [
      ["running", "running"],
      ["error", "failed"],
      ["stopping", "killed"],
      ["unknown", "running"],
    ] as const;

    for (const [status, expected] of statusCases) {
      const next = applyEvent(
        { tasks: { worker: localAgentTask("worker") } },
        {
          type: "background_agent_status",
          payload: {
            agentId: "worker",
            status,
            message: "daemon message",
          },
        },
      );
      expect(next.tasks?.worker).toMatchObject({ status: expected });
    }
  });

  test("maps additional collab status aliases through wait summaries", () => {
    const state: TestState = {
      tasks: {
        complete: localAgentTask("complete"),
        interrupted: localAgentTask("interrupted"),
        shutdown: localAgentTask("shutdown"),
      },
    };

    const next = applyEvent(state, {
      type: "collab_waiting_end",
      payload: {
        agentStatuses: [
          { threadId: "complete", status: "complete" },
          { threadId: "interrupted", status: "interrupted" },
          { threadId: "shutdown", status: "shutdown" },
        ],
      },
    });

    expect(next.tasks?.complete).toMatchObject({
      status: "completed",
      notified: true,
      endTime: 10_000,
    });
    expect(next.tasks?.interrupted).toMatchObject({
      status: "running",
      notified: false,
    });
    expect(next.tasks?.shutdown).toMatchObject({
      status: "killed",
      notified: true,
      endTime: 10_000,
    });
  });
});
