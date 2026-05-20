import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  appState: {
    tasks: {} as Record<string, unknown>,
    teamContext: undefined,
  },
  columns: 90,
  rows: 17,
  todoEnabled: true,
  reset() {
    harness.appState = {
      tasks: {},
      teamContext: undefined,
    };
    harness.columns = 90;
    harness.rows = 17;
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
  isAgentSwarmsEnabled: () => false,
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

async function flushTimers(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
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

function taskSet(firstTaskStatus: TestTask["status"]): TestTask[] {
  return [
    task({
      id: "1",
      status: firstTaskStatus,
      subject: "Freshly completed setup",
    }),
    task({
      id: "2",
      status: "in_progress",
      subject: "Active dependency",
    }),
    task({
      blockedBy: ["10", "2"],
      id: "3",
      status: "in_progress",
      subject: "Blocked integration",
    }),
    task({
      id: "4",
      status: "in_progress",
      subject: "Hidden running",
    }),
    task({
      id: "5",
      subject: "Hidden open",
    }),
    task({
      id: "6",
      status: "completed",
      subject: "Old finished",
    }),
    task({
      blockedBy: ["2"],
      id: "10",
      subject: "Blocked pending dependency",
    }),
  ];
}

async function createTaskListHarness(): Promise<{
  dispose: () => Promise<void>;
  output: () => string;
  render: (tasks: TestTask[]) => Promise<string>;
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

  return {
    dispose: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await flushTimers();
    },
    output: () => stripAnsi(output),
    render: async tasks => {
      output = "";
      root.render(<TaskListV2 tasks={tasks as never} />);
      await flushTimers();
      return stripAnsi(output);
    },
  };
}

describe("TaskListV2 recent completion coverage", () => {
  beforeEach(() => {
    harness.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("keeps a freshly completed task visible until its recent window expires", async () => {
    const rendered = await createTaskListHarness();

    try {
      await rendered.render(taskSet("pending"));

      const recentOutput = await rendered.render(taskSet("completed"));
      expect(recentOutput).toContain("Freshly completed setup");
      expect(recentOutput).toContain("Active dependency");
      expect(recentOutput).toContain("Blocked integration");
      expect(recentOutput).toContain("blocked by #2, #10");
      expect(recentOutput).toContain("+1 in progress, 2 pending, 1 completed");
      expect(recentOutput).not.toContain("Hidden running");

      await vi.advanceTimersByTimeAsync(30_000);
      await flushTimers();

      const expiredOutput = await rendered.render(taskSet("completed"));
      expect(expiredOutput).toContain("Hidden running");
      expect(expiredOutput).toContain("+2 pending, 2 completed");
      expect(expiredOutput).not.toContain("Freshly completed setup");
    } finally {
      await rendered.dispose();
    }
  });
});
