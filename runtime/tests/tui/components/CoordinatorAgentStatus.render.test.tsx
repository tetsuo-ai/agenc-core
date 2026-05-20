import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import { Text } from "../ink.js";
import {
  CoordinatorTaskPanel,
  useCoordinatorTaskCount,
} from "./CoordinatorAgentStatus.js";

const coordinatorMock = vi.hoisted(() => ({
  appState: {
    agentNameRegistry: new Map<string, string>(),
    coordinatorTaskIndex: 0,
    footerSelection: "chat",
    tasks: {} as Record<string, any>,
    viewingAgentTaskId: undefined as string | undefined,
  },
  evicted: [] as string[],
  setAppStateCalls: [] as unknown[],
  terminalColumns: 96,
}));

vi.mock("../state/AppState.js", () => ({
  useAppState: (selector: (state: typeof coordinatorMock.appState) => unknown) =>
    selector(coordinatorMock.appState),
  useSetAppState: () => (update: unknown) => {
    coordinatorMock.setAppStateCalls.push(update);
  },
}));

vi.mock("../hooks/useTerminalSize", () => ({
  useTerminalSize: () => ({
    columns: coordinatorMock.terminalColumns,
    rows: 24,
  }),
}));

vi.mock("../state/teammateViewHelpers", () => ({
  enterTeammateView: (taskId: string, setAppState: (update: unknown) => void) =>
    setAppState({ enter: taskId }),
  exitTeammateView: (setAppState: (update: unknown) => void) =>
    setAppState({ exit: true }),
}));

vi.mock("../../utils/task/framework", () => ({
  evictTerminalTask: (taskId: string, setAppState: (update: unknown) => void) => {
    coordinatorMock.evicted.push(taskId);
    setAppState({ evict: taskId });
  },
}));

function makeTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    agentType: "worker",
    description: `Work for ${id}`,
    diskLoaded: false,
    id,
    isBackgrounded: true,
    lastReportedTokenCount: 0,
    messages: [],
    pendingMessages: [],
    progress: undefined,
    prompt: "do work",
    retain: false,
    startTime: 1_000,
    status: "running",
    totalPausedMs: 0,
    type: "local_agent",
    ...overrides,
  };
}

async function renderToText(node: React.ReactNode, waitMs = 30): Promise<string> {
  let output = "";
  const stdout = new PassThrough();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = coordinatorMock.terminalColumns;

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  try {
    root.render(node);
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(waitMs);
    } else {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    return stripAnsi(output);
  } finally {
    root.unmount();
    stdin.end();
  }
}

function CountProbe() {
  return <Text>{useCoordinatorTaskCount()}</Text>;
}

beforeEach(() => {
  vi.useRealTimers();
  coordinatorMock.appState.agentNameRegistry = new Map();
  coordinatorMock.appState.coordinatorTaskIndex = 0;
  coordinatorMock.appState.footerSelection = "chat";
  coordinatorMock.appState.tasks = {};
  coordinatorMock.appState.viewingAgentTaskId = undefined;
  coordinatorMock.evicted = [];
  coordinatorMock.setAppStateCalls = [];
  coordinatorMock.terminalColumns = 96;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CoordinatorTaskPanel rendering", () => {
  test("renders nothing when no visible panel agent tasks exist", async () => {
    coordinatorMock.appState.tasks = {
      hidden: makeTask("hidden", { evictAfter: 0 }),
      main: makeTask("main", { agentType: "main-session" }),
    };

    expect((await renderToText(<CoordinatorTaskPanel />)).trim()).toBe("");
    expect((await renderToText(<CountProbe />)).trim()).toBe("0");
  });

  test("renders sorted running and terminal agents with names, status, tokens, queues, and selection hints", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(11_000);
    coordinatorMock.appState.footerSelection = "tasks";
    coordinatorMock.appState.coordinatorTaskIndex = 2;
    coordinatorMock.appState.viewingAgentTaskId = "agent-b";
    coordinatorMock.appState.agentNameRegistry = new Map([
      ["Fixer", "agent-b"],
      ["Reviewer", "agent-a"],
    ]);
    coordinatorMock.appState.tasks = {
      agentB: makeTask("agent-b", {
        description: "long running branch fixer",
        pendingMessages: ["one", "two"],
        progress: {
          lastActivity: { activityDescription: "editing" },
          summary: "Applying patch",
          tokenCount: 12_500,
        },
        startTime: 1_000,
      }),
      agentA: makeTask("agent-a", {
        description: "finished review",
        endTime: 9_000,
        pendingMessages: ["queued"],
        startTime: 2_000,
        status: "completed",
        totalPausedMs: 1_000,
      }),
    };

    const output = await renderToText(<CoordinatorTaskPanel />);

    expect(output).toContain("AGENTS");
    expect(output).toContain("2 active");
    expect(output).toContain("orchestrator");
    expect(output.indexOf("Fixer:")).toBeLessThan(output.indexOf("Reviewer:"));
    expect(output).toContain("Fixer:");
    expect(output).toContain("Applying patch");
    expect(output).toContain("12.5k tokens");
    expect(output).toContain("2 queued");
    expect(output).toContain("Reviewer:");
    expect(output).toContain("finished review");
    expect(output).toContain("1 queued");
    expect(output).toContain("x to clear");
    await expect(renderToText(<CountProbe />)).resolves.toContain("3");
  });

  test("evicts expired panel tasks on the interval tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    coordinatorMock.appState.tasks = {
      expired: makeTask("expired", { evictAfter: 19_000 }),
      retained: makeTask("retained", { evictAfter: undefined }),
    };

    await renderToText(<CoordinatorTaskPanel />, 1_050);

    expect(coordinatorMock.evicted).toContain("expired");
    expect(coordinatorMock.evicted).not.toContain("retained");
    expect(coordinatorMock.setAppStateCalls).toContainEqual({ evict: "expired" });
  });
});
