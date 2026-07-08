import { describe, expect, it } from "vitest";

import {
  getAllTasks,
  getTaskByType,
  TaskRegistryError,
} from "./registry.js";

describe("task registry", () => {
  it("registers only live AgenC task kinds", () => {
    expect(getAllTasks().map((task) => task.type)).toEqual([
      "local_bash",
      "local_agent",
      "in_process_teammate",
      "monitor",
      "generic",
    ]);

    expect(getTaskByType("local_bash")?.name).toBe("local shell");
    expect(getTaskByType("local_workflow")).toBeUndefined();
    expect(getTaskByType("monitor_mcp")).toBeUndefined();
    expect(getTaskByType("dream")).toBeUndefined();
    // Deleted producer-less scaffold — must never come back as a registered kind.
    expect(getTaskByType("remote_agent")).toBeUndefined();
  });

  it("delegates kill to the caller-supplied stop implementation", async () => {
    const calls: Array<{ readonly taskId: string; readonly reason: string }> = [];
    const task = getTaskByType("local_agent")!;

    await task.kill("agent-1", {
      reason: "user requested stop",
      stopTask: (taskId, reason) => {
        calls.push({ taskId, reason });
      },
    });

    expect(calls).toEqual([
      { taskId: "agent-1", reason: "user requested stop" },
    ]);
  });

  it("fails instead of pretending to stop without backing cancellation", async () => {
    const task = getTaskByType("local_bash")!;

    await expect(task.kill("bash-1", {})).rejects.toMatchObject({
      code: "stop_failed",
    } satisfies Partial<TaskRegistryError>);
  });
});
