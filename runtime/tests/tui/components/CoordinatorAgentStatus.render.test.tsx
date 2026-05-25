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
  error?: string;
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
    toolUseCount?: number;
  };
  prompt: string;
  retain: boolean;
  retrieved: boolean;
  selectedAgent?: {
    memory?: string;
    source?: string;
  };
  startTime: number;
  status: "completed" | "failed" | "killed" | "pending" | "running";
  totalPausedMs?: number;
  type: "local_agent";
  worktreePath?: string;
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
  (stdout as unknown as { columns: number }).columns = harness.columns;
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

  test("renders nothing and skips the eviction interval when no agent tasks exist", async () => {
    harness.state.tasks = {};
    const rendered = await renderPanel();

    try {
      await sleep(1_075);
      expect(rendered.output().trim()).toBe("");
      expect(harness.evicted).toEqual([]);
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
      expect(output).toContain("AGENT FLEET");
      expect(output).toContain("2 active");
      expect(output).toContain("name · Role");
      expect(output).toContain("last action");
      expect(output).toContain("orchestrator");
      expect(output).toContain("Fixer · Runner");
      expect(output).toContain("◐ running");
      expect(output).toContain("Investigating agent lifecycle");
      expect(output).toContain("1.2k tokens");
      expect(output).toContain("1 queued");
      expect(output).toContain("x to stop");
      expect(output).toContain("Reviewer · Runner");
      expect(output).toContain("● completed");
      expect(output).toContain("Review final patch");
      expect(output).toContain("scope session");
      expect(output).toContain("worktree current checkout");
      expect(output).toContain("last output");
      expect(output).toContain("spend —");
      expect(output.indexOf("Fixer")).toBeLessThan(output.indexOf("Reviewer"));
    } finally {
      await rendered.dispose();
    }
  });

  test("falls back to generic role and idle action when agent metadata is sparse", async () => {
    harness.state.footerSelection = "tasks";
    harness.state.coordinatorTaskIndex = 1;
    harness.state.tasks = {
      "agent-sparse": task("agent-sparse", {
        agentType: "unmapped-role",
        description: "   ",
      }),
    };

    const rendered = await renderPanel();

    try {
      const output = rendered.output();
      expect(output).toContain("agent-sparse · Agent");
      expect(output).toContain("idle");
    } finally {
      await rendered.dispose();
    }
  });

  test("shows active tool progress in the focused agent block", async () => {
    harness.state.footerSelection = "tasks";
    harness.state.coordinatorTaskIndex = 1;
    harness.state.tasks = {
      "agent-tools": task("agent-tools", {
        progress: {
          summary: "using a tool",
          toolUseCount: 2,
        },
      }),
    };

    const rendered = await renderPanel();

    try {
      const output = rendered.output();
      expect(output).toContain("progress ◐ 2 tools");
      expect(output).toContain("using a tool");
    } finally {
      await rendered.dispose();
    }
  });

  test("omits the focused block when main row is selected with a stale viewed agent id", async () => {
    harness.state.footerSelection = "tasks";
    harness.state.coordinatorTaskIndex = 0;
    harness.state.viewingAgentTaskId = "missing-agent";
    harness.state.tasks = {
      "agent-a": task("agent-a", {
        progress: { summary: "visible row remains" },
      }),
    };

    const rendered = await renderPanel();

    try {
      const output = rendered.output();
      expect(output).toContain("AGENT FLEET");
      expect(output).toContain("visible row remains");
      expect(output).not.toContain("scope session");
      expect(output).not.toContain("last output");
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
      expect(output).toContain("last output");
      expect(output).not.toContain("x to stop");
      expect(output).not.toContain("require truncation in a narrow panel");
    } finally {
      await rendered.dispose();
    }
  });

  test("keeps a focused agent block when the selected footer index is stale", async () => {
    harness.state.footerSelection = "tasks";
    harness.state.coordinatorTaskIndex = 99;
    harness.state.agentNameRegistry = new Map([
      ["First", "agent-a"],
      ["FocusedLast", "agent-b"],
    ]);
    harness.state.tasks = {
      "agent-a": task("agent-a", {
        startTime: 990_000,
      }),
      "agent-b": task("agent-b", {
        description: "focused fallback agent",
        progress: { summary: "selected from stale index" },
        selectedAgent: { memory: "repo-memory" },
        startTime: 995_000,
        worktreePath: "/tmp/focused-agent",
      }),
    };

    const rendered = await renderPanel();

    try {
      const output = rendered.output();
      expect(output).toContain("FocusedLast · Runner");
      expect(output).toContain("scope repo-memory");
      expect(output).toContain("worktree /tmp/focused-agent");
      expect(output).toContain("selected from stale index");
    } finally {
      await rendered.dispose();
    }
  });

  test("surfaces failed agent errors as the current action", async () => {
    harness.state.footerSelection = "tasks";
    harness.state.coordinatorTaskIndex = 1;
    harness.state.agentNameRegistry = new Map([["Verifier", "agent-failed"]]);
    harness.state.tasks = {
      "agent-failed": task("agent-failed", {
        description: "generic failure task",
        endTime: 999_000,
        error: "tool exploded while applying patch",
        status: "failed",
      }),
    };

    const rendered = await renderPanel();

    try {
      const output = rendered.output();
      expect(output).toContain("Verifier · Runner");
      expect(output).toContain("failed");
      expect(output).toContain("tool exploded while applying patch");
    } finally {
      await rendered.dispose();
    }
  });

  test("focuses the viewed pending agent when the footer is not selected", async () => {
    harness.state.footerSelection = "none";
    harness.state.viewingAgentTaskId = "agent-pending";
    harness.state.agentNameRegistry = new Map([["Planner", "agent-pending"]]);
    harness.state.tasks = {
      "agent-pending": task("agent-pending", {
        description: "queued analysis",
        selectedAgent: { source: "project-agent" },
        status: "pending",
      }),
    };

    const rendered = await renderPanel();

    try {
      const output = rendered.output();
      expect(output).toContain("Planner · Runner");
      expect(output).toContain("pending");
      expect(output).toContain("scope project-agent");
      expect(output).toContain("queued analysis");
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

  test("keeps completed agents without an eviction deadline visible after the panel tick", async () => {
    harness.state.footerSelection = "tasks";
    harness.state.tasks = {
      retained: task("retained", {
        endTime: undefined,
        evictAfter: undefined,
        status: "completed",
      }),
    };
    const rendered = await renderPanel();

    try {
      await sleep(1_075);
      expect(harness.evicted).toEqual([]);
      expect(rendered.output()).toContain("retained · Runner");
      expect(rendered.output()).toContain("● completed");
    } finally {
      await rendered.dispose();
    }
  });

  test("does not evict reactivated running agents with stale terminal deadlines", async () => {
    harness.state.footerSelection = "tasks";
    harness.state.tasks = {
      reactivated: task("reactivated", {
        endTime: 999_000,
        evictAfter: 999_999,
        progress: { summary: "running after a follow-up message" },
        status: "running",
      }),
    };
    const rendered = await renderPanel();

    try {
      await sleep(1_075);
      expect(harness.evicted).toEqual([]);
      expect(rendered.output()).toContain("running after a follow-up message");
    } finally {
      await rendered.dispose();
    }
  });
});
