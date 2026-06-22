import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BackgroundTaskLifecycle } from "../../tasks/index.js";
import { resolveTimeoutMs } from "../execution.js";
import type { Tool, ToolResult } from "../types.js";
import {
  createBackgroundTaskTools,
  createTaskBoardTools,
  createTaskTools,
} from "./index.js";

function byName(tools: readonly Tool[]): Map<string, Tool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function codeMode<T>(result: ToolResult): T {
  return result.codeModeResult as T;
}

describe("createTaskTools", () => {
  it("exposes the complete Task* family from the task tool module", () => {
    const tools = createTaskTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "TaskCreate",
      "TaskGet",
      "TaskUpdate",
      "TaskList",
      "TaskOutput",
      "TaskStop",
    ]);
  });

  it("keeps durable board creation and app-state expansion behavior local to TaskCreate", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-task-tools-"));
    try {
      const expansions: Array<"none" | "tasks"> = [];
      const tools = createTaskBoardTools({
        workspaceRoot: process.cwd(),
        agencHome: home,
        getSession: () => ({
          appStateBridge: {
            setExpandedView: (next: "none" | "tasks") => expansions.push(next),
          },
        }),
      });
      const map = byName(tools);

      const created = await map.get("TaskCreate")!.execute({
        subject: "Wire tasks",
        description: "Move task tools into their subsystem",
      });
      expect(created.content).toBe("Task #1 created successfully: Wire tasks");
      expect(expansions).toEqual(["tasks"]);

      const task = codeMode<{ task: { id: string; status: string } }>(
        created,
      ).task;
      expect(task.status).toBe("pending");

      const badCreateMetadata = await map.get("TaskCreate")!.execute({
        subject: "Bad metadata",
        description: "Array metadata must be rejected",
        metadata: [],
      });
      expect(badCreateMetadata.isError).toBe(true);
      expect(badCreateMetadata.content).toBe("metadata must be an object");

      expansions.length = 0;
      const badUpdateMetadata = await map.get("TaskUpdate")!.execute({
        taskId: task.id,
        metadata: [],
      });
      expect(badUpdateMetadata.isError).toBe(true);
      expect(badUpdateMetadata.content).toBe("metadata must be an object");
      expect(expansions).toEqual([]);

      const updated = await map.get("TaskUpdate")!.execute({
        taskId: task.id,
        status: "in_progress",
      });
      expect(updated.content).toBe(`Updated task #${task.id} status`);
      expect(expansions).toEqual([]);

      await map.get("TaskCreate")!.execute({
        subject: "Hidden internal task",
        description: "Should not appear in TaskList",
        metadata: { _internal: true },
      });

      const listed = await map.get("TaskList")!.execute({});
      expect(listed.content).toContain("#1 [in_progress] Wire tasks");
      expect(listed.content).not.toContain("Hidden internal task");
      expect(
        codeMode<{ tasks: readonly { subject: string }[] }>(listed).tasks,
      ).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("lets TaskOutput own long blocking deadlines instead of the generic executor", () => {
    const taskOutput = byName(
      createBackgroundTaskTools(new BackgroundTaskLifecycle()),
    ).get("TaskOutput")!;

    expect(taskOutput.timeoutBehavior).toBe("tool");
    expect(resolveTimeoutMs(taskOutput, { timeout: 600_000 })).toBeNull();
  });

  it("reads running and completed background task output from the lifecycle", async () => {
    const lifecycle = new BackgroundTaskLifecycle();
    lifecycle.register({
      id: "agent-1",
      type: "local_agent",
      description: "Inspect repo",
    });
    lifecycle.appendOutput("agent-1", "working");
    const map = byName(createBackgroundTaskTools(lifecycle));

    const badTimeout = await map.get("TaskOutput")!.execute({
      task_id: "agent-1",
      timeout: -1,
    });
    expect(badTimeout.isError).toBe(true);
    expect(badTimeout.content).toBe(
      "timeout must be a number between 0 and 600000",
    );

    const running = await map.get("TaskOutput")!.execute({
      task_id: "agent-1",
      block: false,
    });
    expect(running.content).toContain(
      "<retrieval_status>not_ready</retrieval_status>",
    );
    expect(running.content).toContain("<status>running</status>");
    expect(running.content).toContain("<output>\nworking\n</output>");
    expect(
      codeMode<{ retrieval_status: string; task: { status: string } }>(
        running,
      ),
    ).toMatchObject({
      retrieval_status: "not_ready",
      task: { status: "running" },
    });

    const timedOut = await map.get("TaskOutput")!.execute({
      task_id: "agent-1",
      timeout: 0,
    });
    expect(timedOut.content).toContain(
      "<retrieval_status>timeout</retrieval_status>",
    );
    expect(timedOut.content).toContain("<status>running</status>");
    expect(
      codeMode<{ retrieval_status: string }>(timedOut).retrieval_status,
    ).toBe("timeout");

    lifecycle.complete("agent-1", "\ndone");
    const completed = await map.get("TaskOutput")!.execute({
      task_id: "agent-1",
    });
    expect(completed.content).toContain(
      "<retrieval_status>success</retrieval_status>",
    );
    expect(completed.content).toContain("<status>completed</status>");
    expect(completed.content).toContain("<output>\nworking\ndone\n</output>");
    expect(
      codeMode<{ retrieval_status: string; task: { status: string } }>(
        completed,
      ),
    ).toMatchObject({
      retrieval_status: "success",
      task: { status: "completed" },
    });
  });

  it("stops running background tasks through task_id or shell_id aliases", async () => {
    const lifecycle = new BackgroundTaskLifecycle();
    const abortController = new AbortController();
    let stoppedReason: string | undefined;
    lifecycle.register({
      id: "bash-1",
      type: "local_bash",
      description: "npm test",
      abortController,
      onStop: (reason) => {
        stoppedReason = reason;
      },
    });
    const stop = byName(createBackgroundTaskTools(lifecycle)).get("TaskStop")!;

    const stopped = await stop.execute({ shell_id: "bash-1" });

    expect(stopped.content).toBe("Successfully stopped task: bash-1 (npm test)");
    expect(abortController.signal.aborted).toBe(true);
    expect(stoppedReason).toBe("stopped by TaskStop");
    expect(
      codeMode<{ task_id: string; task_type: string; command: string }>(
        stopped,
      ),
    ).toEqual({
      message: "Successfully stopped task: bash-1 (npm test)",
      task_id: "bash-1",
      task_type: "local_bash",
      command: "npm test",
    });

    const again = await stop.execute({ task_id: "bash-1" });
    expect(again.isError).toBe(true);
    expect(again.content).toBe("task bash-1 is not running (status: killed)");
  });
});
