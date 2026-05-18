import { describe, expect, it } from "vitest";

import { createTaskStateBase, type LocalShellTaskState } from "./types.js";
import { StopTaskError, stopTask, type StopTaskLookupState } from "./stopTask.js";

function shellTask(
  overrides: Partial<LocalShellTaskState> = {},
): LocalShellTaskState {
  return {
    ...createTaskStateBase("bash-1", "local_bash", "npm test"),
    status: "running",
    command: "npm test",
    notified: false,
    ...overrides,
  };
}

describe("stopTask", () => {
  it("stops running tasks through the registry and marks shell notifications after success", async () => {
    const task = shellTask();
    const stopped: Array<{ readonly taskId: string; readonly reason: string }> = [];
    const notified: string[] = [];

    const result = await stopTask("bash-1", {
      getTask: () => task,
      stopTask: (taskId, reason) => {
        stopped.push({ taskId, reason });
      },
      markTaskNotified: (taskId) => {
        notified.push(taskId);
      },
      reason: "stopped by TaskStop",
    });

    expect(stopped).toEqual([
      { taskId: "bash-1", reason: "stopped by TaskStop" },
    ]);
    expect(notified).toEqual(["bash-1"]);
    expect(result).toEqual({
      taskId: "bash-1",
      taskType: "local_bash",
      command: "npm test",
    });
  });

  it("preserves lifecycle semantics by allowing pending tasks when requested", async () => {
    const task = shellTask({ status: "pending" });
    const stopped: string[] = [];

    await stopTask("bash-1", {
      getTask: () => task,
      stopTask: (taskId) => {
        stopped.push(taskId);
      },
      allowPending: true,
    });

    expect(stopped).toEqual(["bash-1"]);
  });

  it("keeps AppState-only donor semantics running-only by default", async () => {
    await expect(
      stopTask("bash-1", {
        getTask: () => shellTask({ status: "pending" }),
        stopTask: () => {},
      }),
    ).rejects.toMatchObject({
      code: "not_running",
    } satisfies Partial<StopTaskError>);
  });

  it("reports missing, terminal, unsupported, and failed stop paths", async () => {
    await expect(
      stopTask("missing", {
        getTask: () => undefined,
        stopTask: () => {},
      }),
    ).rejects.toMatchObject({
      code: "not_found",
    } satisfies Partial<StopTaskError>);

    await expect(
      stopTask("bash-1", {
        getTask: () => shellTask({ status: "completed" }),
        stopTask: () => {},
      }),
    ).rejects.toMatchObject({
      code: "not_running",
    } satisfies Partial<StopTaskError>);

    await expect(
      stopTask("dream-1", {
        getTask: (): StopTaskLookupState => ({
          id: "dream-1",
          type: "dream",
          status: "running",
          description: "dreaming",
        }),
        stopTask: () => {},
      }),
    ).rejects.toMatchObject({
      code: "unsupported_type",
    } satisfies Partial<StopTaskError>);

    const notified: string[] = [];
    await expect(
      stopTask("bash-1", {
        getTask: () => shellTask(),
        stopTask: () => {
          throw new Error("process already exited");
        },
        markTaskNotified: (taskId) => notified.push(taskId),
      }),
    ).rejects.toMatchObject({
      code: "stop_failed",
    } satisfies Partial<StopTaskError>);
    expect(notified).toEqual([]);
  });
});
