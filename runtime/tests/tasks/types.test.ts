import { describe, expect, it } from "vitest";

import {
  createTaskStateBase,
  generateTaskId,
  isAgenCBackgroundTaskType,
  isBackgroundTask,
  isStoppableTaskStatus,
  isTaskType,
  isTerminalTaskStatus,
  type LocalShellTaskState,
} from "./types.js";

function shellTask(
  overrides: Partial<LocalShellTaskState> = {},
): LocalShellTaskState {
  return {
    ...createTaskStateBase("b1", "local_bash", "npm test"),
    status: "running",
    command: "npm test",
    isBackgrounded: true,
    ...overrides,
  };
}

describe("task discriminator types", () => {
  it("recognizes shipped task kinds and rejects dropped donor kinds", () => {
    expect(isTaskType("local_bash")).toBe(true);
    expect(isTaskType("local_agent")).toBe(true);
    expect(isTaskType("in_process_teammate")).toBe(true);

    expect(isAgenCBackgroundTaskType("monitor")).toBe(true);
    expect(isAgenCBackgroundTaskType("generic")).toBe(true);

    // "remote_agent" was a producer-less scaffold deleted from the runtime;
    // it must stay rejected alongside the dropped donor kinds.
    for (const droppedType of [
      "local_workflow",
      "monitor_mcp",
      "dream",
      "remote_agent",
    ]) {
      expect(isTaskType(droppedType)).toBe(false);
      expect(isAgenCBackgroundTaskType(droppedType)).toBe(false);
    }
  });

  it("keeps donor-compatible task status helpers", () => {
    expect(isTerminalTaskStatus("completed")).toBe(true);
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("killed")).toBe(true);
    expect(isTerminalTaskStatus("running")).toBe(false);
    expect(isStoppableTaskStatus("pending")).toBe(true);
    expect(isStoppableTaskStatus("running")).toBe(true);
    expect(isStoppableTaskStatus("completed")).toBe(false);
  });

  it("generates prefixed task IDs and creates base task state", () => {
    expect(generateTaskId("local_bash")).toMatch(/^b[0-9a-z]{8}$/);
    expect(generateTaskId("local_agent")).toMatch(/^a[0-9a-z]{8}$/);
    expect(generateTaskId("monitor")).toMatch(/^m[0-9a-z]{8}$/);

    const base = createTaskStateBase(
      "agent-1",
      "local_agent",
      "inspect repository",
      "tool-1",
    );
    expect(base).toMatchObject({
      id: "agent-1",
      type: "local_agent",
      status: "pending",
      description: "inspect repository",
      toolUseId: "tool-1",
      outputFile: "urn:agenc:task:agent-1:output",
      outputOffset: 0,
      notified: false,
    });
    expect(base.startTime).toBeGreaterThan(0);
  });

  it("filters background tasks by status and foreground flag", () => {
    expect(isBackgroundTask(shellTask())).toBe(true);
    expect(isBackgroundTask(shellTask({ status: "pending" }))).toBe(true);
    expect(isBackgroundTask(shellTask({ status: "completed" }))).toBe(false);
    expect(isBackgroundTask(shellTask({ isBackgrounded: false }))).toBe(false);
    expect(
      isBackgroundTask({
        ...shellTask(),
        type: "local_workflow",
      }),
    ).toBe(false);
    expect(isBackgroundTask(null)).toBe(false);
  });
});
