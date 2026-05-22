import { describe, expect, it } from "vitest";

import {
  formatTaskElapsed,
  inFlightPathsFromTasks,
  taskMayReferencePath,
  taskPathLabel,
} from "../../../src/tui/workbench/agents/activity.js";
import { partitionAgentTasks } from "../../../src/tui/workbench/agents/AgentsRail.js";

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
});
