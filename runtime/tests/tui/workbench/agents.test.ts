import { describe, expect, it } from "vitest";

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
      { id: "agent-2", type: "remote_agent", status: "pending" },
      { id: "agent-3", type: "in_process_teammate", status: "failed" },
      { id: "agent-4", type: "local_agent", status: "completed" },
    ]);

    expect(grouped.activeTasks.map((task) => task.id)).toEqual(["agent-1", "agent-2"]);
    expect(grouped.backgroundTasks.map((task) => task.id)).toEqual(["agent-3", "agent-4"]);
  });

  it("resolves stale agent selection to the first live agent", () => {
    const tasks = [
      { id: "agent-1", type: "local_agent", status: "running" },
      { id: "agent-2", type: "remote_agent", status: "completed" },
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

  it("resolves stale agent selection to the active newest agent before completed tasks", () => {
    const tasks = [
      { id: "agent-old", type: "local_agent", status: "completed", startTime: 1_000 },
      { id: "agent-new", type: "local_agent", status: "running", startTime: 2_000 },
    ];

    expect(resolveAgentSelection(tasks, "agent-gone")).toMatchObject({
      selectedId: "agent-new",
      selectedIndex: 0,
      selectedTask: tasks[1],
    });
  });

  it("orders active agents before background agents and sorts equal groups by newest start time", () => {
    const tasks = [
      { id: "completed-new", type: "local_agent", status: "completed", startTime: 3_000 },
      { id: "running-old", type: "local_agent", status: "running", startTime: 1_000 },
      { id: "pending-new", type: "remote_agent", status: "pending", startTime: 2_000 },
      { id: "failed-missing-start", type: "local_agent", status: "failed" },
    ];

    expect(orderAgentTasks(tasks).map((task) => task.id)).toEqual([
      "pending-new",
      "running-old",
      "completed-new",
      "failed-missing-start",
    ]);

    expect(orderAgentTasks([
      { id: "failed-a", type: "local_agent", status: "failed" },
      { id: "failed-b", type: "local_agent", status: "failed" },
    ]).map((task) => task.id)).toEqual(["failed-a", "failed-b"]);
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
    expect(taskPathLabel(task)).toBe("/repo/worktree");
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
