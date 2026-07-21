import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  activity: {
    endCLIActivity: vi.fn(),
    startCLIActivity: vi.fn(),
  },
  appState: {
    effortValue: "medium",
    expandedView: undefined as undefined | "tasks" | "teammates",
    isBriefOnly: false,
    remoteBackgroundTaskCount: 0,
    remoteConnectionStatus: "connected",
    selectedIPAgentIndex: 0,
    tasks: {} as Record<string, unknown>,
    viewingAgentTaskId: undefined as string | undefined,
    viewSelectionMode: "idle",
  },
  features: new Set<string>(),
  getKairosActive: false,
  getUserMsgOptIn: false,
  localAgents: [] as Array<{ name: string; status?: string }>,
  settings: {
    prefersReducedMotion: false,
    spinnerTipsEnabled: true,
  } as { prefersReducedMotion?: boolean; spinnerTipsEnabled?: boolean } | undefined,
  tasksV2: undefined as undefined | Array<{
    activeForm?: string;
    blockedBy: string[];
    id: string;
    status: string;
    subject: string;
  }>,
  teammateTasks: [] as Array<Record<string, unknown>>,
  turnOutputTokens: 0,
  turnTokenBudget: null as number | null,
  viewedTeammate: undefined as undefined | Record<string, unknown>,
  reset() {
    harness.activity.endCLIActivity.mockClear();
    harness.activity.startCLIActivity.mockClear();
    harness.appState = {
      effortValue: "medium",
      expandedView: undefined,
      isBriefOnly: false,
      remoteBackgroundTaskCount: 0,
      remoteConnectionStatus: "connected",
      selectedIPAgentIndex: 0,
      tasks: {},
      viewingAgentTaskId: undefined,
      viewSelectionMode: "idle",
    };
    harness.features = new Set();
    harness.getKairosActive = false;
    harness.getUserMsgOptIn = false;
    harness.localAgents = [];
    harness.settings = {
      prefersReducedMotion: false,
      spinnerTipsEnabled: true,
    };
    harness.tasksV2 = undefined;
    harness.teammateTasks = [];
    harness.turnOutputTokens = 0;
    harness.turnTokenBudget = null;
    harness.viewedTeammate = undefined;
  },
}));

vi.mock("bun:bundle", () => ({
  feature: (name: string) => harness.features.has(name),
}));

vi.mock("../../../bootstrap/state.js", () => ({
  flushInteractionTime: vi.fn(),
  getCurrentTurnTokenBudget: () => harness.turnTokenBudget,
  getKairosActive: () => harness.getKairosActive,
  getTurnOutputTokens: () => harness.turnOutputTokens,
  getUserMsgOptIn: () => harness.getUserMsgOptIn,
}));

vi.mock("../../../utils/envUtils.js", () => ({
  isEnvTruthy: (value: string | undefined) => value === "1" || value === "true",
}));

vi.mock("lodash-es/sample.js", () => ({
  default: (items: readonly string[]) => items[0],
}));

vi.mock("../../../utils/activityManager.js", () => ({
  activityManager: harness.activity,
}));

vi.mock("../../../constants/spinnerVerbs.js", () => ({
  getSpinnerVerbs: () => ["Working"],
}));

vi.mock("../MessageResponse.js", async () => {
  const ReactModule = await import("react");
  return {
    MessageResponse: ({ children }: { readonly children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

vi.mock("../TaskListV2.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");
  return {
    TaskListV2: ({ tasks }: { readonly tasks: readonly { subject: string }[] }) =>
      ReactModule.createElement(Text, null, `TaskList:${tasks.map(task => task.subject).join(",")}`),
  };
});

vi.mock("../../hooks/useTasksV2.js", () => ({
  useTasksV2: () => harness.tasksV2,
}));

vi.mock("../../state/AppState.js", () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
}));

vi.mock("../../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}));

vi.mock("../../hooks/useSettings.js", () => ({
  useSettings: () => harness.settings,
}));

vi.mock("../../../tasks/InProcessTeammateTask/types.js", () => ({
  isInProcessTeammateTask: (task: { readonly type?: string }) =>
    task.type === "in_process_teammate",
}));

vi.mock("../../../tasks/types.js", () => ({
  isBackgroundTask: (task: { readonly type?: string }) => task.type === "background",
}));

vi.mock("../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js", () => ({
  getAllInProcessTeammateTasks: () => harness.teammateTasks,
}));

vi.mock("../../../utils/effort.js", () => ({
  getEffortSuffix: () => " · effort",
}));

vi.mock("../../../utils/model/model.js", () => ({
  getMainLoopModel: () => "grok-4.3",
}));

vi.mock("../../state/selectors.js", () => ({
  getViewedTeammateTask: () => harness.viewedTeammate,
}));

vi.mock("./SpinnerAnimationRow.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");
  return {
    SpinnerAnimationRow: (props: Record<string, unknown>) =>
      ReactModule.createElement(
        Text,
        null,
        `Animation:${String(props.message)}:${String(props.mode)}:${String(props.effortSuffix)}`,
      ),
  };
});

vi.mock("./TeammateSpinnerTree.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");
  return {
    TeammateSpinnerTree: (props: Record<string, unknown>) =>
      ReactModule.createElement(
        Text,
        null,
        `Tree:${String(props.leaderVerb ?? props.leaderIdleText ?? "none")}:${String(props.allIdle)}`,
      ),
  };
});

vi.mock("./agentActivity.js", () => ({
  formatRunningAgentSummary: (agents: readonly { readonly name: string }[]) =>
    agents.map(agent => agent.name).join(", "),
  getActiveLocalAgentTasks: () => harness.localAgents,
}));

import { createRoot } from "../../ink/root.js";
import { BriefIdleStatus, Spinner, SpinnerWithVerb } from "./Spinner.js";

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

async function renderToText(node: React.ReactNode): Promise<{
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
  root.render(node);
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

function spinnerProps(overrides: Partial<React.ComponentProps<typeof SpinnerWithVerb>> = {}) {
  return {
    loadingStartTimeRef: { current: Date.now() - 10_000 },
    mode: "processing" as const,
    pauseStartTimeRef: { current: null },
    responseLengthRef: { current: 4000 },
    totalPausedMsRef: { current: 0 },
    verbose: false,
    ...overrides,
  };
}

describe("Spinner render paths", () => {
  beforeEach(() => {
    harness.reset();
  });

  test("renders the compact spinner glyph", async () => {
    const rendered = await renderToText(<Spinner />);

    try {
      expect(rendered.output()).toContain("⣷");
    } finally {
      await rendered.dispose();
    }
  });

  test("uses brief spinner mode with connection warning and background count", async () => {
    harness.features.add("KAIROS");
    harness.getKairosActive = true;
    harness.appState.isBriefOnly = true;
    harness.appState.remoteConnectionStatus = "reconnecting";
    harness.appState.remoteBackgroundTaskCount = 2;
    harness.appState.tasks = {
      bg: { type: "background" },
    };

    const rendered = await renderToText(
      <SpinnerWithVerb {...spinnerProps({ mode: "thinking", overrideMessage: "Brief work" })} />,
    );

    try {
      expect(rendered.output()).toContain("Reconnecting");
      expect(rendered.output()).toContain("3 in background");
      expect(harness.activity.startCLIActivity).toHaveBeenCalledWith("spinner-thinking");
    } finally {
      await rendered.dispose();
    }
  });

  test("renders normal spinner rows with next task, token budget, and expanded task list", async () => {
    harness.features.add("TOKEN_BUDGET");
    harness.turnTokenBudget = 1000;
    harness.turnOutputTokens = 2000;
    harness.tasksV2 = [
      {
        activeForm: "Coding",
        blockedBy: [],
        id: "active",
        status: "running",
        subject: "Active task",
      },
      {
        blockedBy: [],
        id: "next",
        status: "pending",
        subject: "Next task",
      },
    ];

    const rendered = await renderToText(
      <SpinnerWithVerb {...spinnerProps({ hasActiveTools: true, spinnerSuffix: "suffix" })} />,
    );

    try {
      // Auto-show (UX request): open tasks surface the todo board on their
      // own, taking priority over the budget/next-task line.
      expect(rendered.output()).toContain("TaskList:Active task,Next task");
      expect(rendered.output()).not.toContain("Next: Next task");
    } finally {
      await rendered.dispose();
    }

    harness.appState.expandedView = "tasks";
    const expanded = await renderToText(<SpinnerWithVerb {...spinnerProps()} />);
    try {
      expect(expanded.output()).toContain("TaskList:Active task,Next task");
    } finally {
      await expanded.dispose();
    }
  });

  test("renders leader idle, teammate tree, and foregrounded idle teammate states", async () => {
    harness.localAgents = [{ name: "Fixer" }];
    harness.teammateTasks = [
      {
        isIdle: false,
        progress: { tokenCount: 1234 },
        status: "running",
        type: "in_process_teammate",
      },
    ];
    harness.appState.expandedView = "teammates";
    harness.appState.viewSelectionMode = "selecting-agent";

    const leaderIdle = await renderToText(
      <SpinnerWithVerb {...spinnerProps({ leaderIsIdle: true })} />,
    );
    try {
      expect(leaderIdle.output()).toContain("Idle · agents running");
      expect(leaderIdle.output()).toContain("Fixer");
      expect(leaderIdle.output()).toContain("Tree:Idle:false");
    } finally {
      await leaderIdle.dispose();
    }

    harness.localAgents = [];
    harness.appState.viewingAgentTaskId = "agent-1";
    harness.viewedTeammate = {
      isIdle: true,
      startTime: Date.now() - 5000,
    };
    harness.teammateTasks = [
      {
        isIdle: true,
        status: "running",
        type: "in_process_teammate",
      },
    ];

    const foregroundedIdle = await renderToText(
      <SpinnerWithVerb {...spinnerProps({ leaderIsIdle: true })} />,
    );
    try {
      expect(foregroundedIdle.output()).toContain("Worked for");
      expect(foregroundedIdle.output()).toContain("Tree:Idle:true");
    } finally {
      await foregroundedIdle.dispose();
    }
  });

  test("renders brief idle status for connection and background agent states", async () => {
    const empty = await renderToText(<BriefIdleStatus />);
    try {
      expect(empty.output().trim()).toBe("");
    } finally {
      await empty.dispose();
    }

    harness.appState.remoteConnectionStatus = "disconnected";
    harness.localAgents = [{ name: "Builder" }];
    const disconnected = await renderToText(<BriefIdleStatus />);
    try {
      expect(disconnected.output()).toContain("Disconnected");
      expect(disconnected.output()).toContain("1 agent running");
    } finally {
      await disconnected.dispose();
    }

    harness.appState.remoteConnectionStatus = "connected";
    harness.localAgents = [];
    harness.appState.remoteBackgroundTaskCount = 4;
    const background = await renderToText(<BriefIdleStatus />);
    try {
      expect(background.output()).toContain("4 in background");
    } finally {
      await background.dispose();
    }
  });
});
