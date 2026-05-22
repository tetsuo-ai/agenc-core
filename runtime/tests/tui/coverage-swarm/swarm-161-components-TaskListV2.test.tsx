import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  appState: {
    tasks: {} as Record<string, unknown>,
    teamContext: undefined as
      | undefined
      | {
          teammates: Record<string, { color?: string; name: string }>;
        },
  },
  columns: 80,
  rows: 24,
  swarmsEnabled: false,
  todoEnabled: true,
  reset() {
    harness.appState = {
      tasks: {},
      teamContext: undefined,
    };
    harness.columns = 80;
    harness.rows = 24;
    harness.swarmsEnabled = false;
    harness.todoEnabled = true;
  },
}));

vi.mock("../../../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: harness.columns, rows: harness.rows }),
}));

vi.mock("../../../src/tui/state/AppState.js", () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
}));

vi.mock("../../../src/utils/tasks.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/utils/tasks.js")>();
  return {
    ...actual,
    isTodoV2Enabled: () => harness.todoEnabled,
  };
});

vi.mock("../../../src/utils/agentSwarmsEnabled.js", () => ({
  isAgentSwarmsEnabled: () => harness.swarmsEnabled,
}));

vi.mock("../../../src/tasks/InProcessTeammateTask/types.js", () => ({
  isInProcessTeammateTask: (task: { readonly type?: string }) =>
    task.type === "in_process_teammate",
}));

vi.mock("../../../src/utils/collapseReadSearch.js", () => ({
  summarizeRecentActivities: (
    activities: readonly Array<{ readonly activityDescription?: string }>,
  ) => activities.map(activity => activity.activityDescription).filter(Boolean).join(" + "),
}));

vi.mock("src/tools/AgentTool/agentColorManager.js", () => ({
  AGENT_COLOR_TO_THEME_COLOR: {
    green: "success",
  },
}));

import { renderToString } from "../../utils/staticRender.js";
import {
  getTaskListTextWidth,
  TaskListV2,
} from "../../../src/tui/components/TaskListV2.js";

type TestTask = {
  activeForm?: string;
  blockedBy: string[];
  blocks: string[];
  description: string;
  id: string;
  owner?: string;
  status: "completed" | "in_progress" | "pending";
  subject: string;
};

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS;

function task(overrides: Partial<TestTask> & Pick<TestTask, "id" | "subject">): TestTask {
  return {
    blockedBy: [],
    blocks: [],
    description: `${overrides.subject} description`,
    status: "pending",
    ...overrides,
  };
}

async function renderTaskList(tasks: TestTask[]): Promise<string> {
  return renderToString(<TaskListV2 tasks={tasks as never} />, {
    columns: harness.columns,
    rows: harness.rows,
  });
}

describe("TaskListV2 coverage swarm row 161", () => {
  beforeEach(() => {
    harness.reset();
    process.env.AGENC_TUI_GLYPHS = "ascii";
  });

  afterEach(() => {
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS;
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode;
    }
  });

  test("normalizes fractional and non-finite row text widths", () => {
    expect(getTaskListTextWidth(81.9, 10.9)).toBe(56);
    expect(getTaskListTextWidth(-20, -3)).toBe(1);
    expect(getTaskListTextWidth(Infinity, 4)).toBe(1);
    expect(getTaskListTextWidth(80, Infinity)).toBe(65);
  });

  test("renders no rows or hidden summary when the terminal is too short", async () => {
    harness.rows = 10;

    const output = await renderTaskList([
      task({ id: "1", status: "in_progress", subject: "Running task" }),
      task({ id: "2", subject: "Queued task" }),
      task({ id: "3", status: "completed", subject: "Finished task" }),
    ]);

    expect(output.trim()).toBe("");
    expect(output).not.toContain("Running task");
    expect(output).not.toContain("+");
  });

  test("uses agent-id activity fallback while hiding owners on narrow terminals", async () => {
    harness.columns = 58;
    harness.swarmsEnabled = true;
    harness.appState.tasks = {
      activeAgent: {
        identity: { agentId: "alice@team", agentName: "alice" },
        progress: {
          lastActivity: { activityDescription: "Reading fallback activity" },
        },
        status: "running",
        type: "in_process_teammate",
      },
      stoppedAgent: {
        identity: { agentId: "bob@team", agentName: "bob" },
        progress: {
          lastActivity: { activityDescription: "Stopped activity" },
        },
        status: "completed",
        type: "in_process_teammate",
      },
    };

    const output = await renderTaskList([
      task({
        id: "1",
        owner: "alice@team",
        status: "in_progress",
        subject: "Agent id owned task",
      }),
    ]);

    expect(output).toContain("Agent id owned task");
    expect(output).toContain("Reading fallback activity...");
    expect(output).not.toContain("@alice@team");
    expect(output).not.toContain("Stopped activity");
  });

  test("renders active owners when teammate colors are missing or unmapped", async () => {
    harness.swarmsEnabled = true;
    harness.appState.teamContext = {
      teammates: {
        badColor: { color: "purple", name: "badColor" },
        goodColor: { color: "green", name: "goodColor" },
        noColor: { name: "noColor" },
      },
    };
    harness.appState.tasks = {
      badColor: {
        identity: { agentId: "badColor@team", agentName: "badColor" },
        status: "running",
        type: "in_process_teammate",
      },
      goodColor: {
        identity: { agentId: "goodColor@team", agentName: "goodColor" },
        status: "running",
        type: "in_process_teammate",
      },
      noColor: {
        identity: { agentId: "noColor@team", agentName: "noColor" },
        status: "running",
        type: "in_process_teammate",
      },
    };

    const output = await renderTaskList([
      task({
        id: "1",
        owner: "badColor",
        status: "in_progress",
        subject: "Unmapped color task",
      }),
      task({
        id: "2",
        owner: "goodColor",
        status: "in_progress",
        subject: "Mapped color task",
      }),
      task({
        id: "3",
        owner: "noColor",
        status: "in_progress",
        subject: "No color task",
      }),
    ]);

    expect(output).toContain("@badColor");
    expect(output).toContain("@goodColor");
    expect(output).toContain("@noColor");
  });
});
