import { describe, expect, test } from "vitest";

import {
  formatLocalAgentName,
  formatRunningAgentSummary,
  getActiveLocalAgentTasks,
  isActiveLocalAgentStatus,
  isStoppableLocalAgentStatus,
  normalizeLocalAgentStatus,
} from "./agentActivity.js";

describe("agent spinner activity helpers", () => {
  test("selects active local agents and sorts them by display name", () => {
    const tasks = {
      shell: { id: "shell", type: "local_bash", status: "running" },
      done: { id: "done", type: "local_agent", status: "completed", description: "Done" },
      zed: { id: "zed", type: "local_agent", status: "running", description: "Zed", isBackgrounded: false },
      ada: { id: "ada", type: "local_agent", status: "pending", description: "Ada", isBackgrounded: false },
      blocked: { id: "blocked", type: "local_agent", status: "blocked", description: "Blocked", isBackgrounded: false },
      background: { id: "background", type: "local_agent", status: "running", description: "Background", isBackgrounded: true },
    };

    expect(getActiveLocalAgentTasks(tasks).map(formatLocalAgentName)).toEqual([
      "Ada",
      "Blocked",
      "Zed",
    ]);
  });

  test("does not keep terminal or idle local agent states active", () => {
    expect(["idle", "failed", "completed", "cancelled", "killed"].map(isActiveLocalAgentStatus)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(["pending", "running", "awaiting_permission", "completing", "failing"].map(isActiveLocalAgentStatus)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  test("marks only starting and running local agents as directly stoppable", () => {
    expect(["pending", "starting", "running", "blocked", "completing", "failed"].map(isStoppableLocalAgentStatus)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  test("falls back from long prompts to stable agent identifiers", () => {
    expect(
      formatLocalAgentName({
        id: "task-id",
        type: "local_agent",
        status: "running",
        description: "This is a very long prompt that should not become a spinner label",
        agentId: "agent-123456789",
      }),
    ).toBe("agent-12");
  });

  test("formats a compact running-agent summary with tokens", () => {
    expect(
      formatRunningAgentSummary([
        {
          id: "a",
          type: "local_agent",
          status: "running",
          description: "Da5id",
          progress: { tokenCount: 1200 },
        },
        {
          id: "b",
          type: "local_agent",
          status: "waiting-on-user",
          description: "SignalJacker",
          progress: { tokenCount: 300 },
        },
      ]),
    ).toBe("2 agents: Da5id running, SignalJacker waiting on user · 1.5k tokens");
  });

  test("normalizes local agent lifecycle states for summaries", () => {
    expect(
      [
        "idle",
        "pending",
        "running",
        "awaiting_permission",
        "completing",
        "failing",
        "failed",
        "completed",
        "killed",
      ].map(normalizeLocalAgentStatus),
    ).toEqual([
      "idle",
      "starting",
      "running",
      "waiting on user",
      "completing",
      "failing",
      "failed",
      "completed",
      "cancelled",
    ]);
  });
});
