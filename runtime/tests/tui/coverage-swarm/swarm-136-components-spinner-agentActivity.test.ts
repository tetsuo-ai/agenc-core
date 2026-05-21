import { describe, expect, test } from "vitest";

import {
  formatLocalAgentName,
  formatRunningAgentSummary,
  getActiveLocalAgentTasks,
  isActiveLocalAgentStatus,
  isStoppableLocalAgentStatus,
  normalizeLocalAgentStatus,
  type ActiveLocalAgentTask,
} from "../../../src/tui/components/spinner/agentActivity.js";

describe("agentActivity coverage swarm row 136", () => {
  test("normalizes blank, aliased, and unknown local agent statuses", () => {
    expect(
      [
        undefined,
        "",
        "   ",
        "Awaiting-User",
        "WAITING_ON_USER",
        "awaiting_permission",
        "blocked",
        "errored",
        "complete",
        "canceled",
        "custom_state",
      ].map(normalizeLocalAgentStatus),
    ).toEqual([
      "idle",
      "idle",
      "idle",
      "waiting on user",
      "waiting on user",
      "waiting on user",
      "waiting on user",
      "failed",
      "completed",
      "cancelled",
      "custom-state",
    ]);
  });

  test("keeps active and stoppable status checks aligned with normalized values", () => {
    expect(isActiveLocalAgentStatus("Awaiting-User")).toBe(true);
    expect(isActiveLocalAgentStatus("custom_state")).toBe(false);
    expect(isActiveLocalAgentStatus(null)).toBe(false);

    expect(isStoppableLocalAgentStatus("STARTING")).toBe(true);
    expect(isStoppableLocalAgentStatus("running")).toBe(true);
    expect(isStoppableLocalAgentStatus("failing")).toBe(false);
    expect(isStoppableLocalAgentStatus("pending_review")).toBe(false);
  });

  test("filters only foreground active local agents and sorts by fallback display name", () => {
    const tasks: Record<string, unknown> = {
      missing: undefined,
      primitive: "running",
      nullish: null,
      otherType: {
        type: "background_task",
        status: "running",
        isBackgrounded: false,
      },
      backgrounded: {
        id: "backgrounded",
        type: "local_agent",
        status: "running",
        description: "Backgrounded",
        isBackgrounded: true,
      },
      implicitBackground: {
        id: "implicit",
        type: "local_agent",
        status: "running",
        description: "Implicit",
      },
      idle: {
        id: "idle",
        type: "local_agent",
        status: "idle",
        description: "Idle",
        isBackgrounded: false,
      },
      beta: {
        id: "task-beta",
        type: "local_agent",
        status: "blocked",
        description: "Beta",
        isBackgrounded: false,
      },
      alpha: {
        id: "task-alpha",
        type: "local_agent",
        status: "running",
        description: "Alpha",
        isBackgrounded: false,
      },
    };

    expect(getActiveLocalAgentTasks(undefined)).toEqual([]);
    expect(getActiveLocalAgentTasks(tasks).map(formatLocalAgentName)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  test("formats names from descriptions, agent types, agent ids, task ids, then a default", () => {
    expect(
      formatLocalAgentName({
        description: "  Ship patch  ",
      }),
    ).toBe("Ship patch");

    expect(
      formatLocalAgentName({
        agentType: "reviewer",
        description: "line one\nline two",
      }),
    ).toBe("reviewer");

    expect(
      formatLocalAgentName({
        agentId: "agent-abcdef123456",
        agentType: "agent",
      }),
    ).toBe("agent-ab");

    expect(
      formatLocalAgentName({
        agentId: "   ",
        id: "task-123456789",
      }),
    ).toBe("task-123");

    expect(formatLocalAgentName({ id: 42 })).toBe("agent");
  });

  test("summarizes one agent without token suffix when tokens are not positive finite numbers", () => {
    const agents: ActiveLocalAgentTask[] = [
      {
        description: "Solo",
        progress: { tokenCount: Number.POSITIVE_INFINITY },
        status: "starting",
      },
    ];

    expect(formatRunningAgentSummary(agents)).toBe("1 agent: Solo starting");
  });

  test("summarizes the first three agents, counts the rest, and adds finite tokens", () => {
    const agents: ActiveLocalAgentTask[] = [
      {
        description: "Alpha",
        progress: { tokenCount: 500 },
        status: "running",
      },
      {
        description: "Beta",
        progress: { tokenCount: "700" },
        status: "awaiting-user",
      },
      {
        description: "Gamma",
        progress: { tokenCount: 1_000 },
        status: "completing",
      },
      {
        description: "Delta",
        progress: { tokenCount: 0 },
        status: "failing",
      },
    ];

    expect(formatRunningAgentSummary(agents)).toBe(
      "4 agents: Alpha running, Beta waiting on user, Gamma completing +1 · 1.5k tokens",
    );
  });
});
