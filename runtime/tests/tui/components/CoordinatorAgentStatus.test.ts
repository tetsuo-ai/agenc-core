import { describe, expect, test } from "vitest";
import {
  getCoordinatorTaskCount,
  getVisibleAgentTasks,
} from "./CoordinatorAgentStatus.js";

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "local_agent",
  agentType: "worker",
  startTime: id === "a" ? 1 : 2,
  status: "running",
  ...extra,
});

describe("CoordinatorAgentStatus", () => {
  test("counts the main row plus every visible local agent row", () => {
    const tasks = {
      a: task("a"),
      b: task("b"),
    };

    expect(getVisibleAgentTasks(tasks).map(agent => agent.id)).toEqual(["a", "b"]);
    expect(getCoordinatorTaskCount(tasks)).toBe(3);
  });

  test("excludes dismissed and main-session local agents from the panel count", () => {
    const tasks = {
      hidden: task("hidden", { evictAfter: 0 }),
      main: task("main", { agentType: "main-session" }),
    };

    expect(getVisibleAgentTasks(tasks)).toEqual([]);
    expect(getCoordinatorTaskCount(tasks)).toBe(0);
  });
});
