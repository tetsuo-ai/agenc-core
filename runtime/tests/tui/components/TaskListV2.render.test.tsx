import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

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

vi.mock("../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: harness.columns, rows: harness.rows }),
}));

vi.mock("../state/AppState.js", () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
}));

vi.mock("../../utils/tasks.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../utils/tasks.js")>();
  return {
    ...actual,
    isTodoV2Enabled: () => harness.todoEnabled,
  };
});

vi.mock("../../utils/agentSwarmsEnabled.js", () => ({
  isAgentSwarmsEnabled: () => harness.swarmsEnabled,
}));

vi.mock("../../tasks/InProcessTeammateTask/types.js", () => ({
  isInProcessTeammateTask: (task: { readonly type?: string }) =>
    task.type === "in_process_teammate",
}));

vi.mock("../../utils/collapseReadSearch.js", () => ({
  summarizeRecentActivities: (
    activities: readonly Array<{ readonly activityDescription?: string }>,
  ) => activities.map(activity => activity.activityDescription).filter(Boolean).join(" + "),
}));

vi.mock("src/tools/AgentTool/agentColorManager.js", () => ({
  AGENT_COLOR_TO_THEME_COLOR: {
    blue: "permission",
    green: "success",
  },
}));

import { createRoot } from "../ink/root.js";
import { TaskListV2 } from "./TaskListV2.js";

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

function createStreams(): {
  stdout: PassThrough & { columns?: number; rows?: number };
  stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
} {
  const stdout = new PassThrough() as PassThrough & {
    columns?: number;
    rows?: number;
  };
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  stdout.columns = harness.columns;
  stdout.rows = harness.rows;
  stdout.resume();
  return { stdin, stdout };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function task(overrides: Partial<TestTask> & Pick<TestTask, "id" | "subject">): TestTask {
  return {
    blockedBy: [],
    blocks: [],
    description: `${overrides.subject} description`,
    status: "pending",
    ...overrides,
  };
}

async function renderTaskList(
  tasks: TestTask[],
  isStandalone = false,
): Promise<{
  dispose: () => Promise<void>;
  output: () => string;
}> {
  let output = "";
  const { stdin, stdout } = createStreams();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  root.render(<TaskListV2 tasks={tasks as never} isStandalone={isStandalone} />);
  await sleep();
  return {
    dispose: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    },
    output: () => stripAnsi(output),
  };
}

describe("TaskListV2 rendering", () => {
  beforeEach(() => {
    harness.reset();
  });

  test("renders nothing when task UI is disabled or empty", async () => {
    harness.todoEnabled = false;
    const disabled = await renderTaskList([
      task({ id: "1", subject: "Hidden task" }),
    ]);
    harness.todoEnabled = true;
    const empty = await renderTaskList([]);

    try {
      expect(disabled.output().trim()).toBe("");
      expect(empty.output().trim()).toBe("");
    } finally {
      await disabled.dispose();
      await empty.dispose();
    }
  });

  test("renders standalone counts and sorted task rows", async () => {
    const rendered = await renderTaskList(
      [
        task({ id: "2", status: "completed", subject: "Write docs" }),
        task({ id: "10", subject: "Ship release" }),
        task({ id: "1", status: "in_progress", subject: "Run tests" }),
        task({ id: "abc", subject: "Non numeric id" }),
      ],
      true,
    );

    try {
      const output = rendered.output();
      expect(output).toContain("4 tasks (1 done, 1 in progress, 2 open)");
      expect(output.indexOf("Run tests")).toBeLessThan(output.indexOf("Write docs"));
      expect(output.indexOf("Write docs")).toBeLessThan(output.indexOf("Ship release"));
      expect(output.indexOf("Ship release")).toBeLessThan(output.indexOf("Non numeric id"));
    } finally {
      await rendered.dispose();
    }
  });

  test("shows blockers and hides blocked activity", async () => {
    harness.swarmsEnabled = true;
    harness.appState.tasks = {
      teammate: {
        identity: { agentId: "alice@team", agentName: "alice" },
        progress: {
          lastActivity: { activityDescription: "Reading files" },
          recentActivities: [{ activityDescription: "Scanning" }],
        },
        status: "running",
        type: "in_process_teammate",
      },
    };

    const rendered = await renderTaskList([
      task({ id: "1", status: "in_progress", subject: "Active dependency" }),
      task({
        blockedBy: ["1"],
        id: "2",
        owner: "alice",
        status: "in_progress",
        subject: "Blocked teammate work",
      }),
    ]);

    try {
      const output = rendered.output();
      expect(output).toContain("Blocked teammate work");
      expect(output).toContain("blocked by #1");
      expect(output).toContain("@alice");
      expect(output).not.toContain("Scanning");
    } finally {
      await rendered.dispose();
    }
  });

  test("shows active teammate activity and colorized owner when swarms are enabled", async () => {
    harness.swarmsEnabled = true;
    harness.appState.teamContext = {
      teammates: {
        alice: { color: "blue", name: "alice" },
      },
    };
    harness.appState.tasks = {
      teammate: {
        identity: { agentId: "alice@team", agentName: "alice" },
        progress: {
          lastActivity: { activityDescription: "Reading files" },
          recentActivities: [
            { activityDescription: "Searching" },
            { activityDescription: "Reading files" },
          ],
        },
        status: "running",
        type: "in_process_teammate",
      },
    };

    const rendered = await renderTaskList([
      task({
        id: "1",
        owner: "alice",
        status: "in_progress",
        subject: "Investigate logs",
      }),
    ]);

    try {
      const output = rendered.output();
      expect(output).toContain("@alice");
      expect(output).toContain("Searching + Reading files…");
    } finally {
      await rendered.dispose();
    }
  });

  test("truncates rows and summarizes hidden task states on short terminals", async () => {
    harness.rows = 17;
    const rendered = await renderTaskList([
      task({ id: "1", status: "completed", subject: "Completed one" }),
      task({ id: "2", status: "in_progress", subject: "Running two" }),
      task({ id: "3", subject: "Open three" }),
      task({ id: "4", status: "completed", subject: "Completed four" }),
      task({ id: "5", subject: "Open five", blockedBy: ["2"] }),
    ]);

    try {
      const output = rendered.output();
      expect(output).toContain("Running two");
      expect(output).toContain("Open three");
      expect(output).toContain("Open five");
      expect(output).toContain("blocked by #2");
      expect(output).not.toContain("Completed one");
      expect(output).not.toContain("Completed four");
      expect(output).toContain("… +2 completed");
    } finally {
      await rendered.dispose();
    }
  });
});
