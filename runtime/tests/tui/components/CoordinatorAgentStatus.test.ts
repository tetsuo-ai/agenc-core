import { describe, expect, test } from "vitest";
import {
  AGENT_PANEL_TRANSIENT_MS,
  getCoordinatorTaskCount,
  getCoordinatorTaskPanelVisibilityKey,
  getVisibleAgentTasks,
  shouldShowCoordinatorTaskPanel,
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

  test("opens the panel while a new agent task is in its transient display window", () => {
    const visibleTasks = getVisibleAgentTasks({
      a: task("a"),
      b: task("b"),
    });

    expect(shouldShowCoordinatorTaskPanel({
      visibleTasks,
      footerSelection: null,
      viewingAgentTaskId: undefined,
      transientVisibleUntil: 1_000 + AGENT_PANEL_TRANSIENT_MS,
      now: 1_000,
    })).toBe(true);
  });

  test("collapses the panel after the transient display window expires", () => {
    const visibleTasks = getVisibleAgentTasks({
      a: task("a"),
      b: task("b"),
    });

    expect(shouldShowCoordinatorTaskPanel({
      visibleTasks,
      footerSelection: null,
      viewingAgentTaskId: undefined,
      transientVisibleUntil: 1_000 + AGENT_PANEL_TRANSIENT_MS,
      now: 1_000 + AGENT_PANEL_TRANSIENT_MS,
    })).toBe(false);
  });

  test("shows the panel when the tasks footer is selected", () => {
    const visibleTasks = getVisibleAgentTasks({
      a: task("a"),
    });

    expect(shouldShowCoordinatorTaskPanel({
      visibleTasks,
      footerSelection: "tasks",
      viewingAgentTaskId: undefined,
      transientVisibleUntil: 0,
      now: 1_000,
    })).toBe(true);
  });

  test("shows the panel while viewing one of its agents", () => {
    const visibleTasks = getVisibleAgentTasks({
      a: task("a"),
    });

    expect(shouldShowCoordinatorTaskPanel({
      visibleTasks,
      footerSelection: null,
      viewingAgentTaskId: "a",
      transientVisibleUntil: 0,
      now: 1_000,
    })).toBe(true);
  });

  test("changes the transient visibility key when an agent reaches terminal state", () => {
    const running = getVisibleAgentTasks({
      a: task("a", { status: "running" }),
    });
    const completed = getVisibleAgentTasks({
      a: task("a", { status: "completed", endTime: 10 }),
    });

    expect(getCoordinatorTaskPanelVisibilityKey(running)).not.toBe(
      getCoordinatorTaskPanelVisibilityKey(completed),
    );
  });
});
