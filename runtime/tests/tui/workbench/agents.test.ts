import { describe, expect, it, vi } from "vitest";

import {
  formatTaskElapsed,
  inFlightPathsFromTasks,
  taskMayReferencePath,
  taskPathLabel,
} from "../../../src/tui/workbench/agents/activity.js";
import { orderAgentTasks, partitionAgentTasks, resolveAgentSelection } from "../../../src/tui/workbench/agents/AgentsRail.js";

describe("workbench agents rail model", () => {
  it("groups active and background agent tasks", () => {
    const grouped = partitionAgentTasks([
      { id: "agent-1", type: "local_agent", status: "running" },
      { id: "agent-2", type: "local_agent", status: "pending" },
      { id: "agent-3", type: "in_process_teammate", status: "failed" },
      { id: "agent-4", type: "local_agent", status: "completed" },
    ]);

    expect(grouped.activeTasks.map((task) => task.id)).toEqual(["agent-1", "agent-2"]);
    expect(grouped.backgroundTasks.map((task) => task.id)).toEqual(["agent-3", "agent-4"]);
  });

  it("resolves stale agent selection to the first live agent", () => {
    const tasks = [
      { id: "agent-1", type: "local_agent", status: "running" },
      { id: "agent-2", type: "local_agent", status: "completed" },
    ];

    expect(resolveAgentSelection(tasks, "agent-2")).toMatchObject({
      selectedId: "agent-2",
      selectedIndex: 1,
      selectedTask: tasks[1],
    });
    expect(resolveAgentSelection(tasks, "agent-gone")).toMatchObject({
      selectedId: "agent-1",
      selectedIndex: 0,
      selectedTask: tasks[0],
    });
    expect(resolveAgentSelection([], "agent-gone")).toEqual({
      selectedId: null,
      selectedIndex: -1,
      selectedTask: null,
    });
  });

  it("resolves stale agent selection to the first observed agent", () => {
    const tasks = [
      { id: "agent-old", type: "local_agent", status: "completed", startTime: 1_000 },
      { id: "agent-new", type: "local_agent", status: "running", startTime: 2_000 },
    ];

    expect(resolveAgentSelection(tasks, "agent-gone")).toMatchObject({
      selectedId: "agent-old",
      selectedIndex: 0,
      selectedTask: tasks[0],
    });
  });

  it("preserves first-seen agent order and appends newly observed agents", () => {
    const tasks = [
      { id: "completed-new", type: "local_agent", status: "completed", startTime: 3_000 },
      { id: "running-old", type: "local_agent", status: "running", startTime: 1_000 },
      { id: "pending-new", type: "local_agent", status: "pending", startTime: 2_000 },
      { id: "failed-missing-start", type: "local_agent", status: "failed" },
    ];

    expect(orderAgentTasks(tasks).map((task) => task.id)).toEqual([
      "completed-new",
      "running-old",
      "pending-new",
      "failed-missing-start",
    ]);

    expect(orderAgentTasks(tasks, ["running-old", "completed-new"]).map((task) => task.id)).toEqual([
      "running-old",
      "completed-new",
      "pending-new",
      "failed-missing-start",
    ]);

    expect(orderAgentTasks([
      { id: "failed-gone", type: "local_agent", status: "failed" },
      { id: "failed-a", type: "local_agent", status: "failed" },
      { id: "failed-b", type: "local_agent", status: "failed" },
    ], ["failed-a", "failed-gone"]).map((task) => task.id)).toEqual([
      "failed-a",
      "failed-gone",
      "failed-b",
    ]);
  });

  it("formats elapsed runtime and extracts task paths", () => {
    const task = {
      id: "agent-1",
      type: "local_agent",
      status: "running",
      description: "working",
      startTime: 1_000,
      totalPausedMs: 500,
      outputFile: "urn:agenc:task:agent-1:output",
      outputOffset: 0,
      notified: false,
      cwd: "/repo/worktree",
    } as any;

    expect(formatTaskElapsed(task, 66_500)).toBe("1m05s");
    expect(formatTaskElapsed({ ...task, endTime: 3_661_000 }, 99_999_999)).toBe("1h00m");
    expect(formatTaskElapsed({ ...task, totalPausedMs: undefined }, 61_000)).toBe("1m00s");
    expect(taskPathLabel(task)).toBe("/repo/worktree");
    expect(taskPathLabel({ ...task, cwd: "  /repo/trimmed  " })).toBe("/repo/trimmed");
    expect(taskPathLabel({
      ...task,
      cwd: undefined,
      outputFile: "urn:agenc:task:agent-1:output",
    })).toBe(null);
    expect(taskPathLabel({
      ...task,
      cwd: undefined,
      worktreePath: "  /repo/other-worktree  ",
    })).toBe("/repo/other-worktree");
  });

  it("identifies in-flight paths from active agent activity", () => {
    const task = {
      id: "agent-1",
      type: "local_agent",
      status: "running",
      description: "editing src/app.ts",
      startTime: 0,
      outputFile: "urn:agenc:task:agent-1:output",
      outputOffset: 0,
      notified: false,
      progress: {
        recentActivities: [{
          activityDescription: "patch src/app.ts",
        }],
      },
    } as any;

    expect(taskMayReferencePath(task, "src/app.ts")).toBe(true);
    expect(inFlightPathsFromTasks([task], ["src/app.ts", "src/other.ts"])).toEqual(["src/app.ts"]);
  });

  it("serializes each task's inputs once, not once per candidate path (M-TUI-10)", () => {
    const task = {
      id: "agent-1",
      type: "local_agent",
      status: "running",
      description: "work",
      startTime: 0,
      progress: {
        lastActivity: { input: { file_path: "src/target.ts" } },
      },
    } as any;
    const candidatePaths = Array.from({ length: 20 }, (_, i) => `src/p${i}.ts`);
    candidatePaths.push("src/target.ts");

    const spy = vi.spyOn(JSON, "stringify");
    const result = inFlightPathsFromTasks([task], candidatePaths);
    const stringifyCalls = spy.mock.calls.length;
    spy.mockRestore();

    // Correctness preserved: the object input's path is still detected.
    expect(result).toContain("src/target.ts");
    // Perf invariant: the task input is JSON.stringified ~once (per task), not
    // once per candidate path (21x) — the per-path re-serialization was the bug.
    expect(stringifyCalls).toBeLessThan(candidatePaths.length);
  });

  it("rejects empty path candidates before searching task activity", () => {
    const task = {
      id: "agent-1",
      type: "local_agent",
      status: "running",
      description: "editing src/app.ts",
      startTime: 0,
      outputFile: "urn:agenc:task:agent-1:output",
      outputOffset: 0,
      notified: false,
    } as any;

    expect(taskMayReferencePath(task, null)).toBe(false);
    expect(taskMayReferencePath(task, undefined)).toBe(false);
    expect(taskMayReferencePath(task, "./")).toBe(false);
    expect(taskMayReferencePath(task, "  src/app.ts  ")).toBe(true);
    expect(inFlightPathsFromTasks([{ ...task, type: "local_bash" }], ["src/app.ts"])).toEqual([]);
  });

  it("searches command, prompt, title, and tool inputs for path references", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const commandTask = {
      id: "agent-command",
      type: "local_agent",
      status: "running",
      description: "background work",
      startTime: 0,
      outputFile: "urn:agenc:task:agent-command:output",
      outputOffset: 0,
      notified: false,
      command: "review src/command.ts",
      title: "inspect src/title.ts",
      progress: {
        lastActivity: {
          toolName: "Read",
          activityDescription: "read src/activity.ts",
          input: { file_path: "C:\\repo\\src\\windows.ts" },
        },
        recentActivities: [
          { toolName: "Edit", input: "src/string-input.ts" },
          { toolName: "Noop", input: null },
          { toolName: "Circular", input: circular },
        ],
      },
    } as any;
    const localTask = {
      id: "agent-local",
      type: "local_agent",
      status: "running",
      description: "local work",
      startTime: 0,
      outputFile: "urn:agenc:task:agent-local:output",
      outputOffset: 0,
      notified: false,
      prompt: "change src/prompt.ts",
      worktreePath: "src/worktree.ts",
    } as any;

    expect(taskMayReferencePath(commandTask, "src/command.ts")).toBe(true);
    expect(taskMayReferencePath(commandTask, "src/title.ts")).toBe(true);
    expect(taskMayReferencePath(commandTask, "src/activity.ts")).toBe(true);
    expect(taskMayReferencePath(commandTask, "src/windows.ts")).toBe(true);
    expect(taskMayReferencePath(commandTask, "src/string-input.ts")).toBe(true);
    expect(taskMayReferencePath(localTask, "src/prompt.ts")).toBe(true);
    expect(taskMayReferencePath(localTask, "src/worktree.ts")).toBe(true);
  });

  it("ignores missing or non-string task search fields", () => {
    const task = {
      id: "src/app.ts",
      type: "local_agent",
      status: "running",
      description: undefined,
      startTime: 0,
      outputFile: "urn:agenc:task:agent-1:output",
      outputOffset: 0,
      notified: false,
      progress: {
        lastActivity: {
          toolName: undefined,
          activityDescription: undefined,
        },
      },
    } as any;

    expect(taskMayReferencePath(task, "src/app.ts")).toBe(true);
  });

  it("does not treat longer sibling file names as the selected in-flight path", () => {
    const task = {
      id: "agent-1",
      type: "local_agent",
      status: "running",
      description: "editing src/app.tsx",
      startTime: 0,
      outputFile: "urn:agenc:task:agent-1:output",
      outputOffset: 0,
      notified: false,
    } as any;

    expect(taskMayReferencePath(task, "src/app.ts")).toBe(false);
    expect(taskMayReferencePath(task, "src/app.tsx")).toBe(true);
    expect(inFlightPathsFromTasks([task], ["src/app.ts", "src/app.tsx"])).toEqual(["src/app.tsx"]);
  });

  it("recognizes path references with absolute prefixes and line suffixes", () => {
    const task = {
      id: "agent-1",
      type: "local_agent",
      status: "running",
      description: "patch /repo/src/app.ts:42",
      startTime: 0,
      outputFile: "urn:agenc:task:agent-1:output",
      outputOffset: 0,
      notified: false,
    } as any;

    expect(taskMayReferencePath(task, "src/app.ts")).toBe(true);
  });
});
