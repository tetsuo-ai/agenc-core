import { describe, expect, test } from "vitest";

import {
  formatLocalAgentName,
  formatRunningAgentSummary,
  getActiveLocalAgentTasks,
} from "./agentActivity.js";

describe("agent spinner activity helpers", () => {
  test("selects active local agents and sorts them by display name", () => {
    const tasks = {
      shell: { id: "shell", type: "local_bash", status: "running" },
      done: { id: "done", type: "local_agent", status: "completed" },
      zed: { id: "zed", type: "local_agent", status: "running", description: "Zed" },
      ada: { id: "ada", type: "local_agent", status: "pending", description: "Ada" },
    };

    expect(getActiveLocalAgentTasks(tasks).map(formatLocalAgentName)).toEqual([
      "Ada",
      "Zed",
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
          status: "running",
          description: "SignalJacker",
          progress: { tokenCount: 300 },
        },
      ]),
    ).toBe("2 agents running: Da5id, SignalJacker · 1.5k tokens");
  });
});
