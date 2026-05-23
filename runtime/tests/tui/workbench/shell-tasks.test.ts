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

  it("returns null when no local shell task is available", () => {
    expect(resolveWorkbenchShellTask({ "agent-1": agentTask("agent-1") }, "agent-1")).toBeNull();
    expect(resolveWorkbenchShellTask({}, null)).toBeNull();
  });
});

function shellTask(id: string) {
  return {
    id,
    type: "local_bash",
    status: "running",
    description: "npm test",
    command: "npm test",
    startTime: 1_000,
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
