import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  appState: {
    agentNameRegistry: new Map<string, string>(),
    coordinatorTaskIndex: 0,
    footerSelection: "chat" as "chat" | "tasks",
    tasks: {} as Record<string, unknown>,
    viewingAgentTaskId: undefined as string | undefined,
  },
  entered: [] as string[],
  evicted: [] as string[],
  exited: 0,
  setAppState: vi.fn(),
  terminalColumns: 80,
}));

vi.mock("../../../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: harness.terminalColumns, rows: 24 }),
}));

vi.mock("../../../src/tui/state/AppState.js", () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
  useSetAppState: () => harness.setAppState,
}));

vi.mock("../../../src/tui/state/teammateViewHelpers.js", () => ({
  enterTeammateView: (taskId: string) => {
    harness.entered.push(taskId);
  },
  exitTeammateView: () => {
    harness.exited++;
  },
}));

vi.mock("../../../src/utils/task/framework.js", () => ({
  evictTerminalTask: (taskId: string) => {
    harness.evicted.push(taskId);
  },
}));

import { createRoot } from "../../../src/tui/ink/root.js";
import {
  getCoordinatorTaskCount,
  getCoordinatorTaskPanelVisibilityKey,
  getVisibleAgentTasks,
  shouldShowCoordinatorTaskPanel,
  CoordinatorTaskPanel,
} from "../../../src/tui/components/CoordinatorAgentStatus.js";

type AgentTask = {
  agentId: string;
  agentType: string;
  description: string;
  diskLoaded: boolean;
  endTime?: number;
  evictAfter?: number;
  id: string;
  isBackgrounded: boolean;
  lastReportedTokenCount: number;
  lastReportedToolCount: number;
  pendingMessages: string[];
  progress?: {
    lastActivity?: Record<string, unknown>;
    summary?: string;
    tokenCount?: number;
  };
  prompt: string;
  retain: boolean;
  retrieved: boolean;
  startTime: number;
  status: "completed" | "failed" | "killed" | "pending" | "running";
  totalPausedMs?: number;
  type: "local_agent";
};

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type TestStdout = PassThrough & {
  columns: number;
  isTTY: boolean;
  rows: number;
};

function task(id: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    agentId: id,
    agentType: "worker",
    description: `${id} task description`,
    diskLoaded: false,
    id,
    isBackgrounded: true,
    lastReportedTokenCount: 0,
    lastReportedToolCount: 0,
    pendingMessages: [],
    prompt: `${id} prompt`,
    retain: false,
    retrieved: false,
    startTime: 1_000,
    status: "running",
    type: "local_agent",
    ...overrides,
  };
}

function createStreams(): { stdin: TestStdin; stdout: TestStdout } {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough() as TestStdout;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};

  stdout.columns = harness.terminalColumns;
  stdout.rows = 24;
  stdout.isTTY = true;
  stdout.resume();

  return { stdin, stdout };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function renderPanel(): Promise<{
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

  root.render(<CoordinatorTaskPanel />);
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

function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

describe("CoordinatorAgentStatus coverage swarm row 117", () => {
  beforeEach(() => {
    harness.appState = {
      agentNameRegistry: new Map(),
      coordinatorTaskIndex: 0,
      footerSelection: "chat",
      tasks: {},
      viewingAgentTaskId: undefined,
    };
    harness.entered = [];
    harness.evicted = [];
    harness.exited = 0;
    harness.setAppState.mockClear();
    harness.terminalColumns = 80;
    vi.spyOn(Date, "now").mockReturnValue(10_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("filters visible panel agents and encodes visibility keys for running and ended tasks", () => {
    const visible = getVisibleAgentTasks({
      dismissed: task("dismissed", { evictAfter: 0, startTime: 1 }),
      main: task("main", { agentType: "main-session", startTime: 2 }),
      plain: { id: "plain", startTime: 3, status: "running", type: "other" },
      later: task("later", { endTime: 10, startTime: 30, status: "completed" }),
      earlier: task("earlier", { startTime: 20, status: "pending" }),
    });

    expect(visible.map(agent => agent.id)).toEqual(["earlier", "later"]);
    expect(getCoordinatorTaskCount({})).toBe(0);
    expect(getCoordinatorTaskPanelVisibilityKey(visible)).toBe(
      "earlier:pending:20:|later:completed:30:10",
    );
  });

  test("keeps the panel hidden for empty or unrelated viewed task states", () => {
    const visibleTasks = [task("active")];

    expect(
      shouldShowCoordinatorTaskPanel({
        footerSelection: "tasks",
        now: 10_000,
        transientVisibleUntil: 20_000,
        viewingAgentTaskId: undefined,
        visibleTasks: [],
      }),
    ).toBe(false);

    expect(
      shouldShowCoordinatorTaskPanel({
        footerSelection: "chat",
        now: 10_000,
        transientVisibleUntil: 10_000,
        viewingAgentTaskId: "missing",
        visibleTasks,
      }),
    ).toBe(false);
  });

  test("renders transient agents without task-footer selection or action hints", async () => {
    harness.appState.footerSelection = "chat";
    harness.appState.tasks = {
      active: task("active", {
        description: "Audit the status panel",
        progress: { tokenCount: 12 },
      }),
    };

    const rendered = await renderPanel();

    try {
      const output = rendered.output();
      const compactOutput = compact(output);
      expect(compactOutput).toContain("AGENTFLEET");
      expect(compactOutput).toContain("1active");
      expect(output).toContain("orchestrator");
      expect(compactOutput).toContain("Auditthestatuspanel");
      expect(compactOutput).toContain("12tokens");
      expect(compactOutput).not.toContain("xtostop");
      expect(output).not.toContain("active:");
    } finally {
      await rendered.dispose();
    }
  });

  test("marks the orchestrator row selected while leaving unselected agents without hints", async () => {
    harness.appState.footerSelection = "tasks";
    harness.appState.coordinatorTaskIndex = 0;
    harness.appState.tasks = {
      active: task("active", { description: "Keep watching worker output" }),
    };

    const rendered = await renderPanel();

    try {
      const output = rendered.output();
      const compactOutput = compact(output);
      expect(output).toContain("orchestrator");
      expect(compactOutput).toContain("Keepwatchingworkeroutput");
      expect(compactOutput).not.toContain("xtostop");
      expect(compactOutput).not.toContain("xtoclear");
    } finally {
      await rendered.dispose();
    }
  });
});
