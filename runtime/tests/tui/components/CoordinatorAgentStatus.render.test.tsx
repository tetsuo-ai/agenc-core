import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  columns: 100,
  entered: [] as string[],
  evicted: [] as string[],
  exited: 0,
  setAppState: vi.fn(),
  state: {
    agentNameRegistry: new Map<string, string>(),
    coordinatorTaskIndex: 0,
    footerSelection: "none" as "none" | "tasks",
    tasks: {} as Record<string, unknown>,
    viewingAgentTaskId: undefined as string | undefined,
  },
  reset() {
    harness.columns = 100;
    harness.entered = [];
    harness.evicted = [];
    harness.exited = 0;
    harness.setAppState.mockClear();
    harness.state = {
      agentNameRegistry: new Map(),
      coordinatorTaskIndex: 0,
      footerSelection: "none",
      tasks: {},
      viewingAgentTaskId: undefined,
    };
  },
}));

vi.mock("../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: harness.columns, rows: 24 }),
}));

vi.mock("../state/AppState.js", () => ({
  useAppState: (selector: (state: typeof harness.state) => unknown) =>
    selector(harness.state),
  useSetAppState: () => harness.setAppState,
}));

vi.mock("../state/teammateViewHelpers.js", () => ({
  enterTeammateView: (taskId: string) => {
    harness.entered.push(taskId);
  },
  exitTeammateView: () => {
    harness.exited++;
  },
}));

vi.mock("../../utils/task/framework.js", () => ({
  evictTerminalTask: (taskId: string) => {
    harness.evicted.push(taskId);
  },
}));

import { createRoot } from "../ink/root.js";
import { Box, Text } from "../ink.js";
import {
  CoordinatorTaskPanel,
  useCoordinatorTaskCount,
} from "./CoordinatorAgentStatus.js";

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
  status: "completed" | "failed" | "killed" | "running";
  totalPausedMs?: number;
  type: "local_agent";
};

function createStreams(): {
  stdout: PassThrough;
  stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
} {
  const stdout = new PassThrough();
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
  stdout.resume();
  return { stdin, stdout };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function task(id: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    agentId: id,
    agentType: "worker",
    description: `${id} description`,
    diskLoaded: false,
    id,
    isBackgrounded: true,
    lastReportedTokenCount: 0,
    lastReportedToolCount: 0,
    pendingMessages: [],
    prompt: `${id} prompt`,
    retain: false,
    retrieved: false,
    startTime: Date.now() - 8_000,
    status: "running",
    type: "local_agent",
    ...overrides,
  };
}

async function renderPanel(
  element: React.ReactNode = <CoordinatorTaskPanel />,
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
  root.render(<Box flexDirection="column">{element}</Box>);
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

describe("CoordinatorTaskPanel rendering", () => {
  beforeEach(() => {
    harness.reset();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders nothing when no panel-managed agents are visible", async () => {
    harness.state.tasks = {
      dismissed: task("dismissed", { evictAfter: 0 }),
      main: task("main", { agentType: "main-session" }),
    };
    const rendered = await renderPanel();

    try {
      expect(rendered.output().trim()).toBe("");
    } finally {
      await rendered.dispose();
    }
  });

  test("renders visible agents with names, progress, queued counts, and selection hints", async () => {
    harness.state.footerSelection = "tasks";
    harness.state.coordinatorTaskIndex = 1;
    harness.state.agentNameRegistry = new Map([
      ["Fixer", "agent-a"],
      ["Reviewer", "agent-b"],
    ]);
    harness.state.tasks = {
      "agent-b": task("agent-b", {
        description: "Review final patch",
        endTime: 997_000,
        evictAfter: 1_100_000,
        startTime: 992_000,
        status: "completed",
        totalPausedMs: 1_000,
      }),
      "agent-a": task("agent-a", {
        pendingMessages: ["please continue"],
        progress: {
          lastActivity: { toolName: "Read" },
          summary: "Investigating agent lifecycle",
          tokenCount: 1_200,
        },
        startTime: 990_000,
      }),
    };

    const rendered = await renderPanel();

    try {
      const output = rendered.output();
      expect(output).toContain("AGENTS");
      expect(output).toContain("2 active");
      expect(output).toContain("orchestrator");
      expect(output).toContain("Fixer · Runner · Investigating agent lifecycle");
      expect(output).toContain("1 queued");
      expect(output).toContain("x to stop");
      expect(output).toContain("Reviewer · Runner · Review final patch");
      expect(output.indexOf("Fixer")).toBeLessThan(output.indexOf("Reviewer"));
    } finally {
      await rendered.dispose();
    }
  });

  test("uses viewed-agent styling without action hints and truncates narrow descriptions", async () => {
    harness.columns = 46;
    harness.state.footerSelection = "tasks";
    harness.state.coordinatorTaskIndex = 1;
    harness.state.viewingAgentTaskId = "agent-a";
    harness.state.agentNameRegistry = new Map([["ChromeLotus", "agent-a"]]);
    harness.state.tasks = {
      "agent-a": task("agent-a", {
        description: "This description is long enough to require truncation in a narrow panel",
        progress: { tokenCount: 5 },
      }),
    };

    const rendered = await renderPanel();

    try {
      const output = rendered.output();
      expect(output).toContain("ChromeLotus · Runner");
      expect(output).toContain("tokens");
      expect(output).not.toContain("x to stop");
      expect(output).not.toContain("require truncation in a narrow panel");
    } finally {
      await rendered.dispose();
    }
  });

  test("exposes coordinator count through the hook", async () => {
    harness.state.tasks = {
      "agent-a": task("agent-a"),
      hidden: task("hidden", { evictAfter: 0 }),
    };
    function CountProbe(): React.ReactNode {
      return <Text>Count:{useCoordinatorTaskCount()}</Text>;
    }
    const rendered = await renderPanel(<CountProbe />);

    try {
      expect(rendered.output()).toContain("Count:2");
    } finally {
      await rendered.dispose();
    }
  });

  test("evicts expired retained terminal agents on the panel tick", async () => {
    harness.state.tasks = {
      expired: task("expired", {
        endTime: 999_000,
        evictAfter: 999_999,
        status: "completed",
      }),
    };
    const rendered = await renderPanel();

    try {
      await sleep(1_075);
      expect(harness.evicted).toEqual(["expired"]);
    } finally {
      await rendered.dispose();
    }
  });
});
