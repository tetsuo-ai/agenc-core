import { describe, expect, it } from "vitest";

import { resolveWorkbenchShellTask } from "../../../src/tui/workbench/tasks/shellTasks.js";

describe("resolveWorkbenchShellTask", () => {
  it("uses the selected task when it is a local shell task", () => {
    const shell = shellTask("shell-1");

    expect(resolveWorkbenchShellTask({ "shell-1": shell }, "shell-1")).toBe(shell);
  });

  it("falls back to a live shell task when the selected id is stale or non-shell", () => {
    const shell = shellTask("shell-1");
    const agent = agentTask("agent-1");

    expect(resolveWorkbenchShellTask({ "agent-1": agent, "shell-1": shell }, "agent-1")).toBe(shell);
    expect(resolveWorkbenchShellTask({ "shell-1": shell }, "missing")).toBe(shell);
  });

  it("falls back to the running newest shell task when no selected shell task is usable", () => {
    const oldCompleted = shellTask("shell-old", {
      status: "completed",
      startTime: 1_000,
    });
    const newRunning = shellTask("shell-new", {
      status: "running",
      startTime: 2_000,
    });

    expect(resolveWorkbenchShellTask({
      "shell-old": oldCompleted,
      "shell-new": newRunning,
    }, "missing")).toBe(newRunning);
  });

  it("falls back to the newest shell task when none are active", () => {
    const oldCompleted = shellTask("shell-old", {
      status: "completed",
      startTime: 1_000,
    });
    const newFailed = shellTask("shell-new", {
      status: "failed",
      startTime: 2_000,
    });

    expect(resolveWorkbenchShellTask({
      "shell-old": oldCompleted,
      "shell-new": newFailed,
    }, null)).toBe(newFailed);
  });

  it("returns null when no local shell task is available", () => {
    expect(resolveWorkbenchShellTask({ "agent-1": agentTask("agent-1") }, "agent-1")).toBeNull();
    expect(resolveWorkbenchShellTask({}, null)).toBeNull();
  });
});

function shellTask(
  id: string,
  overrides: Partial<{
    readonly status: "pending" | "running" | "completed" | "failed" | "killed";
    readonly startTime: number;
  }> = {},
) {
  return {
    id,
    type: "local_bash",
    status: overrides.status ?? "running",
    description: "npm test",
    command: "npm test",
    startTime: overrides.startTime ?? 1_000,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
  } as const;
}

function agentTask(id: string) {
  return {
    id,
    type: "local_agent",
    status: "running",
    description: "agent work",
    startTime: 1_000,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
    agentId: id,
    prompt: "inspect",
    agentType: "default",
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  } as const;
}
