import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../../ink/root.js";
import {
  BriefIdleStatus,
  Spinner,
  SpinnerWithVerb,
} from "./Spinner.js";

const spinnerMock = vi.hoisted(() => ({
  activity: {
    ended: [] as string[],
    started: [] as string[],
  },
  appState: {
    effortValue: "medium",
    expandedView: undefined as string | undefined,
    isBriefOnly: false,
    remoteBackgroundTaskCount: 0,
    remoteConnectionStatus: "connected",
    selectedIPAgentIndex: 0,
    tasks: {} as Record<string, any>,
    viewingAgentTaskId: undefined as string | undefined,
    viewSelectionMode: "normal",
  },
  currentTurnTokenBudget: null as number | null,
  featureFlags: new Set<string>(),
  getKairosActive: false,
  getUserMsgOptIn: false,
  localAgents: [] as Array<{ id: string; summary: string }>,
  outputTokens: 0,
  settings: {
    prefersReducedMotion: false,
    spinnerTipsEnabled: true,
  } as { prefersReducedMotion?: boolean; spinnerTipsEnabled?: boolean },
  tasksV2: undefined as any[] | undefined,
  terminalColumns: 80,
}));

vi.mock("bun:bundle", () => ({
  feature: (name: string) => spinnerMock.featureFlags.has(name),
}));

vi.mock("../../../bootstrap/state.js", () => ({
  flushInteractionTime: () => {},
  getCurrentTurnTokenBudget: () => spinnerMock.currentTurnTokenBudget,
  getKairosActive: () => spinnerMock.getKairosActive,
  getTurnOutputTokens: () => spinnerMock.outputTokens,
  getUserMsgOptIn: () => spinnerMock.getUserMsgOptIn,
}));

vi.mock("../../../utils/activityManager.js", () => ({
  activityManager: {
    endCLIActivity: (id: string) => {
      spinnerMock.activity.ended.push(id);
    },
    startCLIActivity: (id: string) => {
      spinnerMock.activity.started.push(id);
    },
  },
}));

vi.mock("../../../constants/spinnerVerbs.js", () => ({
  getSpinnerVerbs: () => ["Working"],
}));

vi.mock("../MessageResponse.js", async () => {
  const React = await import("react");
  const { Box } = await vi.importActual<typeof import("../../ink.js")>("../../ink.js");
  return {
    MessageResponse: ({ children }: { children: React.ReactNode }) =>
      React.createElement(Box, { flexDirection: "column" }, children),
  };
});

vi.mock("../TaskListV2.js", async () => {
  const React = await import("react");
  const { Text } = await vi.importActual<typeof import("../../ink.js")>("../../ink.js");
  return {
    TaskListV2: ({ tasks }: { tasks: unknown[] }) =>
      React.createElement(Text, null, `TASKS:${tasks.length}`),
  };
});

vi.mock("../../hooks/useTasksV2.js", () => ({
  useTasksV2: () => spinnerMock.tasksV2,
}));

vi.mock("../../state/AppState.js", () => ({
  useAppState: (selector: (state: typeof spinnerMock.appState) => unknown) =>
    selector(spinnerMock.appState),
}));

vi.mock("../../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: spinnerMock.terminalColumns, rows: 24 }),
}));

vi.mock("../../hooks/useSettings.js", () => ({
  useSettings: () => spinnerMock.settings,
}));

vi.mock("../../../tasks/InProcessTeammateTask/types.js", () => ({
  isInProcessTeammateTask: (task: any) => task?.type === "in_process_teammate",
}));

vi.mock("../../../tasks/types.js", () => ({
  isBackgroundTask: (task: any) => task?.type === "background_task",
}));

vi.mock("../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js", () => ({
  getAllInProcessTeammateTasks: (tasks: Record<string, any>) =>
    Object.values(tasks ?? {}).filter(task => task?.type === "in_process_teammate"),
}));

vi.mock("../../../utils/effort.js", () => ({
  getEffortSuffix: (_model: string, effort: string) => `:${effort}`,
}));

vi.mock("../../../utils/model/model.js", () => ({
  getMainLoopModel: () => "gpt-test",
}));

vi.mock("../../state/selectors.js", () => ({
  getViewedTeammateTask: ({ viewingAgentTaskId, tasks }: any) =>
    viewingAgentTaskId ? tasks?.[viewingAgentTaskId] : undefined,
}));

vi.mock("./SpinnerAnimationRow.js", async () => {
  const React = await import("react");
  const { Text } = await vi.importActual<typeof import("../../ink.js")>("../../ink.js");
  return {
    SpinnerAnimationRow: (props: any) =>
      React.createElement(
        Text,
        null,
        [
          "ROW",
          props.mode,
          props.reducedMotion ? "reduced" : "motion",
          props.message,
          `tokens:${props.teammateTokens}`,
          `thinking:${String(props.thinkingStatus)}`,
          props.spinnerSuffix ? `suffix:${props.spinnerSuffix}` : "",
          props.effortSuffix,
        ].filter(Boolean).join(" "),
      ),
  };
});

vi.mock("./TeammateSpinnerTree.js", async () => {
  const React = await import("react");
  const { Text } = await vi.importActual<typeof import("../../ink.js")>("../../ink.js");
  return {
    TeammateSpinnerTree: (props: any) =>
      React.createElement(
        Text,
        null,
        `TREE selected:${props.selectedIndex ?? "none"} idle:${String(props.allIdle)} leader:${props.leaderVerb ?? props.leaderIdleText ?? ""} tokens:${props.leaderTokenCount}`,
      ),
  };
});

vi.mock("./agentActivity.js", () => ({
  formatRunningAgentSummary: (agents: Array<{ summary: string }>) =>
    agents.map(agent => agent.summary).join(", "),
  getActiveLocalAgentTasks: () => spinnerMock.localAgents,
}));

function makeRef<T>(current: T): React.RefObject<T> {
  return { current };
}

function defaultSpinnerProps(
  overrides: Partial<React.ComponentProps<typeof SpinnerWithVerb>> = {},
): React.ComponentProps<typeof SpinnerWithVerb> {
  return {
    loadingStartTimeRef: makeRef(Date.now() - 10_000),
    mode: "responding",
    pauseStartTimeRef: makeRef(null),
    responseLengthRef: makeRef(4096),
    totalPausedMsRef: makeRef(0),
    verbose: false,
    ...overrides,
  };
}

function makeTeammate(overrides: Record<string, any> = {}) {
  return {
    id: "teammate-1",
    isIdle: false,
    progress: { tokenCount: 128 },
    spinnerVerb: "Reviewing",
    startTime: Date.now() - 3_000,
    status: "running",
    type: "in_process_teammate",
    ...overrides,
  };
}

async function renderToText(node: React.ReactNode): Promise<string> {
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
  (stdout as unknown as { columns: number }).columns = spinnerMock.terminalColumns;

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  try {
    root.render(node);
    await new Promise(resolve => setTimeout(resolve, 30));
    return stripAnsi(output);
  } finally {
    root.unmount();
    stdin.end();
  }
}

async function renderSequenceToText(
  nodes: React.ReactNode[],
  advanceMs = 30,
): Promise<string> {
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
  (stdout as unknown as { columns: number }).columns = spinnerMock.terminalColumns;

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  try {
    for (const node of nodes) {
      root.render(node);
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(advanceMs);
      } else {
        await new Promise(resolve => setTimeout(resolve, advanceMs));
      }
    }
    return stripAnsi(output);
  } finally {
    root.unmount();
    stdin.end();
  }
}

beforeEach(() => {
  vi.useRealTimers();
  spinnerMock.activity.ended = [];
  spinnerMock.activity.started = [];
  spinnerMock.appState.effortValue = "medium";
  spinnerMock.appState.expandedView = undefined;
  spinnerMock.appState.isBriefOnly = false;
  spinnerMock.appState.remoteBackgroundTaskCount = 0;
  spinnerMock.appState.remoteConnectionStatus = "connected";
  spinnerMock.appState.selectedIPAgentIndex = 0;
  spinnerMock.appState.tasks = {};
  spinnerMock.appState.viewingAgentTaskId = undefined;
  spinnerMock.appState.viewSelectionMode = "normal";
  spinnerMock.currentTurnTokenBudget = null;
  spinnerMock.featureFlags.clear();
  spinnerMock.getKairosActive = false;
  spinnerMock.getUserMsgOptIn = false;
  spinnerMock.localAgents = [];
  spinnerMock.outputTokens = 0;
  spinnerMock.settings = {
    prefersReducedMotion: false,
    spinnerTipsEnabled: true,
  };
  spinnerMock.tasksV2 = undefined;
  spinnerMock.terminalColumns = 80;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Spinner rendering", () => {
  test("renders the compact static spinner glyph", async () => {
    const output = await renderToText(<Spinner />);

    expect(output).toContain("◐");
  });

  test("routes brief-only mode to the brief spinner with background status", async () => {
    spinnerMock.featureFlags.add("KAIROS_BRIEF");
    spinnerMock.getKairosActive = true;
    spinnerMock.appState.isBriefOnly = true;
    spinnerMock.appState.remoteBackgroundTaskCount = 3;
    spinnerMock.terminalColumns = 64;

    const output = await renderToText(
      <SpinnerWithVerb {...defaultSpinnerProps({ overrideMessage: "Summarizing" })} />,
    );

    expect(output).toContain("Summarizing");
    expect(output).toContain("3 in background");
    expect(spinnerMock.activity.started).toContain("spinner-responding");
  });

  test("shows brief connection warnings and hides overflowing right text", async () => {
    // The brief gate enters via the user opt-in branch when AGENC_BRIEF is set
    // (getKairosActive stays false). The growthbook flag that used to drive
    // this is inlined out, so the env opt-in is the surviving entry point.
    const previousBriefEnv = process.env.AGENC_BRIEF;
    process.env.AGENC_BRIEF = "1";
    spinnerMock.featureFlags.add("KAIROS");
    spinnerMock.getUserMsgOptIn = true;
    spinnerMock.appState.isBriefOnly = true;
    spinnerMock.appState.remoteConnectionStatus = "disconnected";
    spinnerMock.appState.remoteBackgroundTaskCount = 12;
    spinnerMock.terminalColumns = 18;

    try {
      const output = await renderToText(<SpinnerWithVerb {...defaultSpinnerProps()} />);

      expect(output).toContain("Disconnected");
      expect(output).not.toContain("12 in background");
    } finally {
      if (previousBriefEnv === undefined) {
        delete process.env.AGENC_BRIEF;
      } else {
        process.env.AGENC_BRIEF = previousBriefEnv;
      }
    }
  });

  test("renders the full spinner row with next task, tip, budget, and teammate tokens", async () => {
    spinnerMock.featureFlags.add("TOKEN_BUDGET");
    spinnerMock.currentTurnTokenBudget = 10_000;
    spinnerMock.outputTokens = 5_000;
    spinnerMock.appState.tasks = {
      teammate: makeTeammate({ progress: { tokenCount: 2500 } }),
    };
    spinnerMock.tasksV2 = [
      { activeForm: "Editing", blockedBy: [], id: "current", status: "running", subject: "current" },
      { blockedBy: ["done"], id: "next", status: "pending", subject: "write tests" },
      { blockedBy: ["current"], id: "blocked", status: "pending", subject: "blocked" },
      { blockedBy: [], id: "done", status: "completed", subject: "done" },
    ];

    const output = await renderToText(
      <SpinnerWithVerb
        {...defaultSpinnerProps({
          spinnerSuffix: "tail",
          spinnerTip: "keep coverage moving",
        })}
      />,
    );

    expect(output).toContain("ROW responding");
    expect(output).toContain("Editing");
    expect(output).toContain("tokens:2500");
    expect(output).toContain("suffix:tail");
    // Auto-show: open tasks surface the todo board and win over budget/next.
    expect(output).toContain("TASKS:4");
    expect(output).not.toContain("Next: write tests");
    expect(output).not.toContain("Tip: keep coverage moving");
  });

  test("shows expanded task list instead of tips when task view is active", async () => {
    spinnerMock.appState.expandedView = "tasks";
    spinnerMock.tasksV2 = [
      { blockedBy: [], id: "task-1", status: "running", subject: "first task" },
    ];

    const output = await renderToText(
      <SpinnerWithVerb {...defaultSpinnerProps({ spinnerTip: "hidden tip" })} />,
    );

    expect(output).toContain("TASKS:1");
    expect(output).not.toContain("hidden tip");
  });

  test("shows teammate tree mode with selection state", async () => {
    spinnerMock.appState.expandedView = "teammates";
    spinnerMock.appState.selectedIPAgentIndex = 2;
    spinnerMock.appState.viewSelectionMode = "selecting-agent";
    spinnerMock.appState.tasks = {
      teammate: makeTeammate(),
    };

    const output = await renderToText(<SpinnerWithVerb {...defaultSpinnerProps()} />);

    expect(output).toContain("TREE selected:2");
    expect(output).toContain("tokens:1024");
  });

  test("uses a foregrounded running teammate spinner verb", async () => {
    spinnerMock.appState.viewingAgentTaskId = "teammate";
    spinnerMock.appState.tasks = {
      teammate: makeTeammate({ spinnerVerb: "Investigating" }),
    };

    const output = await renderToText(
      <SpinnerWithVerb {...defaultSpinnerProps({ overrideMessage: "Leader message" })} />,
    );

    expect(output).toContain("Investigating");
    expect(output).not.toContain("Leader message");
  });

  test("shows static leader idle status while agents continue running", async () => {
    spinnerMock.localAgents = [{ id: "agent-1", summary: "Fixer working" }];

    const output = await renderToText(
      <SpinnerWithVerb {...defaultSpinnerProps({ leaderIsIdle: true })} />,
    );

    expect(output).toContain("Idle");
    expect(output).toContain("agents running");
    expect(output).toContain("Fixer working");
    expect(output).not.toContain("ROW responding");
  });

  test("shows static leader idle status while teammates continue running", async () => {
    spinnerMock.appState.tasks = {
      teammate: makeTeammate({ isIdle: false }),
    };

    const output = await renderToText(
      <SpinnerWithVerb {...defaultSpinnerProps({ leaderIsIdle: true })} />,
    );

    expect(output).toContain("Idle");
    expect(output).toContain("teammates running");
    expect(output).not.toContain("agents running");
  });

  test("shows static foregrounded teammate idle status", async () => {
    spinnerMock.appState.viewingAgentTaskId = "teammate";
    spinnerMock.appState.expandedView = "teammates";
    spinnerMock.appState.tasks = {
      teammate: makeTeammate({ isIdle: true }),
    };

    const output = await renderToText(<SpinnerWithVerb {...defaultSpinnerProps()} />);

    expect(output).toContain("Worked for");
    expect(output).toContain("TREE selected:0");
  });

  test("shows idle instead of worked-for when other teammates remain active", async () => {
    spinnerMock.appState.viewingAgentTaskId = "idle";
    spinnerMock.appState.tasks = {
      idle: makeTeammate({ id: "idle", isIdle: true }),
      active: makeTeammate({ id: "active", isIdle: false }),
    };

    const output = await renderToText(<SpinnerWithVerb {...defaultSpinnerProps()} />);

    expect(output).toContain("Idle");
    expect(output).not.toContain("Worked for");
  });

  test("shows explicit tips, long-context tips, and complete budget text", async () => {
    const tipOutput = await renderToText(
      <SpinnerWithVerb {...defaultSpinnerProps({ spinnerTip: "prefer focused tests" })} />,
    );
    expect(tipOutput).toContain("Tip: prefer focused tests");

    const longContextOutput = await renderToText(
      <SpinnerWithVerb
        {...defaultSpinnerProps({
          loadingStartTimeRef: makeRef(Date.now() - 1_900_000),
          spinnerTip: "overridden tip",
        })}
      />,
    );
    expect(longContextOutput).toContain("Tip: Use /clear to start fresh");
    expect(longContextOutput).not.toContain("overridden tip");

    spinnerMock.featureFlags.add("TOKEN_BUDGET");
    spinnerMock.currentTurnTokenBudget = 5000;
    spinnerMock.outputTokens = 6000;
    const budgetOutput = await renderToText(<SpinnerWithVerb {...defaultSpinnerProps()} />);
    expect(budgetOutput).toContain("Target: 6.0k used (5.0k min");
  });

  test("tracks thinking status across mode transitions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const thinkingProps = defaultSpinnerProps({ mode: "thinking" });
    const respondingProps = defaultSpinnerProps({ mode: "responding" });
    const output = await renderSequenceToText([
      <SpinnerWithVerb {...thinkingProps} />,
      <SpinnerWithVerb {...respondingProps} />,
    ], 2100);

    expect(output).toContain("thinking:thinking");
    expect(output).toContain("thinking:2100");
  });

  test("renders brief idle placeholder, warnings, background counts, and local agents", async () => {
    const emptyOutput = await renderToText(<BriefIdleStatus />);
    expect(emptyOutput.trim()).toBe("");

    spinnerMock.appState.remoteConnectionStatus = "reconnecting";
    spinnerMock.appState.remoteBackgroundTaskCount = 4;
    spinnerMock.terminalColumns = 60;
    await expect(renderToText(<BriefIdleStatus />)).resolves.toContain("Reconnecting");
    await expect(renderToText(<BriefIdleStatus />)).resolves.toContain("4 in background");

    spinnerMock.localAgents = [{ id: "agent-1", summary: "Agent active" }];
    const localOutput = await renderToText(<BriefIdleStatus />);
    expect(localOutput).toContain("1 agent running");
  });
});
