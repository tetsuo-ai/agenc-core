import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  activity: {
    ended: [] as string[],
    started: [] as string[],
  },
  appState: {
    effortValue: "medium",
    expandedView: undefined as "tasks" | "teammates" | undefined,
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
  growthbookBrief: false,
  localAgents: [] as Array<{ id: string; summary: string }>,
  outputTokens: 0,
  settings: {
    prefersReducedMotion: false,
    spinnerTipsEnabled: true,
  } as { prefersReducedMotion?: boolean; spinnerTipsEnabled?: boolean } | undefined,
  spinnerVerbs: ["Working"] as string[],
  tasksV2: undefined as any[] | undefined,
  terminalColumns: 80,
}));

vi.mock("bun:bundle", () => ({
  feature: (name: string) => harness.featureFlags.has(name),
}));

vi.mock("../../../src/bootstrap/state.js", () => ({
  flushInteractionTime: () => {},
  getCurrentTurnTokenBudget: () => harness.currentTurnTokenBudget,
  getKairosActive: () => harness.getKairosActive,
  getTurnOutputTokens: () => harness.outputTokens,
  getUserMsgOptIn: () => harness.getUserMsgOptIn,
}));

vi.mock("../../../src/services/analytics/growthbook.js", () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => harness.growthbookBrief,
}));

vi.mock("../../../src/utils/envUtils.js", () => ({
  isEnvTruthy: (value: string | undefined) => value === "1" || value === "true",
}));

vi.mock("lodash-es/sample.js", () => ({
  default: (items: readonly string[]) => items[0],
}));

vi.mock("../../../src/utils/activityManager.js", () => ({
  activityManager: {
    endCLIActivity: (id: string) => {
      harness.activity.ended.push(id);
    },
    startCLIActivity: (id: string) => {
      harness.activity.started.push(id);
    },
  },
}));

vi.mock("../../../src/constants/spinnerVerbs.js", () => ({
  getSpinnerVerbs: () => harness.spinnerVerbs,
}));

vi.mock("../../../src/tui/components/MessageResponse.js", async () => {
  const ReactModule = await import("react");
  return {
    MessageResponse: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

vi.mock("../../../src/tui/components/TaskListV2.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await vi.importActual<typeof import("../../../src/tui/ink.js")>(
    "../../../src/tui/ink.js",
  );
  return {
    TaskListV2: ({ tasks }: { tasks: Array<{ subject: string }> }) =>
      ReactModule.createElement(
        Text,
        null,
        `TASKS:${tasks.map(task => task.subject).join(",")}`,
      ),
  };
});

vi.mock("../../../src/tui/hooks/useTasksV2.js", () => ({
  useTasksV2: () => harness.tasksV2,
}));

vi.mock("../../../src/tui/state/AppState.js", () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
}));

vi.mock("../../../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: harness.terminalColumns, rows: 24 }),
}));

vi.mock("../../../src/tui/hooks/useSettings.js", () => ({
  useSettings: () => harness.settings,
}));

vi.mock("../../../src/tasks/InProcessTeammateTask/types.js", () => ({
  isInProcessTeammateTask: (task: any) => task?.type === "in_process_teammate",
}));

vi.mock("../../../src/tasks/types.js", () => ({
  isBackgroundTask: (task: any) => task?.type === "background_task",
}));

vi.mock("../../../src/tasks/InProcessTeammateTask/InProcessTeammateTask.js", () => ({
  getAllInProcessTeammateTasks: (tasks: Record<string, any>) =>
    Object.values(tasks ?? {}).filter(task => task?.type === "in_process_teammate"),
}));

vi.mock("../../../src/utils/effort.js", () => ({
  getEffortSuffix: (_model: string, effort: string) => `:${effort}`,
}));

vi.mock("../../../src/utils/model/model.js", () => ({
  getMainLoopModel: () => "grok-4.3",
}));

vi.mock("../../../src/tui/state/selectors.js", () => ({
  getViewedTeammateTask: ({ viewingAgentTaskId, tasks }: any) =>
    viewingAgentTaskId ? tasks?.[viewingAgentTaskId] : undefined,
}));

vi.mock("../../../src/tui/components/spinner/SpinnerAnimationRow.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await vi.importActual<typeof import("../../../src/tui/ink.js")>(
    "../../../src/tui/ink.js",
  );
  return {
    SpinnerAnimationRow: (props: Record<string, unknown>) =>
      ReactModule.createElement(
        Text,
        null,
        [
          "ROW",
          String(props.mode),
          String(props.message),
          `tokens:${String(props.teammateTokens)}`,
          `teammates:${String(props.hasRunningTeammates)}`,
          `thinking:${String(props.thinkingStatus)}`,
          String(props.effortSuffix),
        ].join("|"),
      ),
  };
});

vi.mock("../../../src/tui/components/spinner/TeammateSpinnerTree.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await vi.importActual<typeof import("../../../src/tui/ink.js")>(
    "../../../src/tui/ink.js",
  );
  return {
    TeammateSpinnerTree: (props: Record<string, unknown>) =>
      ReactModule.createElement(
        Text,
        null,
        `TREE:${String(props.leaderVerb ?? props.leaderIdleText ?? "")}:${String(props.allIdle)}`,
      ),
  };
});

vi.mock("../../../src/tui/components/spinner/agentActivity.js", () => ({
  formatRunningAgentSummary: (agents: Array<{ summary: string }>) =>
    agents.map(agent => agent.summary).join(", "),
  getActiveLocalAgentTasks: () => harness.localAgents,
}));

import { createRoot } from "../../../src/tui/ink/root.js";
import {
  BriefIdleStatus,
  SpinnerWithVerb,
} from "../../../src/tui/components/spinner/Spinner.js";

function makeRef<T>(current: T): React.RefObject<T> {
  return { current };
}

function spinnerProps(
  overrides: Partial<React.ComponentProps<typeof SpinnerWithVerb>> = {},
): React.ComponentProps<typeof SpinnerWithVerb> {
  return {
    loadingStartTimeRef: makeRef(Date.now() - 10_000),
    mode: "responding",
    pauseStartTimeRef: makeRef(null),
    responseLengthRef: makeRef(2048),
    totalPausedMsRef: makeRef(0),
    verbose: false,
    ...overrides,
  };
}

function teammate(overrides: Record<string, any> = {}) {
  return {
    id: "teammate-1",
    isIdle: false,
    startTime: Date.now() - 5_000,
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
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = harness.terminalColumns;

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  try {
    root.render(node);
    await new Promise(resolve => setTimeout(resolve, 30));
    return stripAnsi(output);
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
  }
}

beforeEach(() => {
  harness.activity.ended = [];
  harness.activity.started = [];
  harness.appState.effortValue = "medium";
  harness.appState.expandedView = undefined;
  harness.appState.isBriefOnly = false;
  harness.appState.remoteBackgroundTaskCount = 0;
  harness.appState.remoteConnectionStatus = "connected";
  harness.appState.selectedIPAgentIndex = 0;
  harness.appState.tasks = {};
  harness.appState.viewingAgentTaskId = undefined;
  harness.appState.viewSelectionMode = "normal";
  harness.currentTurnTokenBudget = null;
  harness.featureFlags.clear();
  harness.getKairosActive = false;
  harness.getUserMsgOptIn = false;
  harness.growthbookBrief = false;
  harness.localAgents = [];
  harness.outputTokens = 0;
  harness.settings = {
    prefersReducedMotion: false,
    spinnerTipsEnabled: true,
  };
  harness.spinnerVerbs = ["Working"];
  harness.tasksV2 = undefined;
  harness.terminalColumns = 80;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Spinner coverage swarm row 076", () => {
  test("keeps the full spinner while viewing a teammate in brief-only mode", async () => {
    harness.featureFlags.add("KAIROS_BRIEF");
    harness.getKairosActive = true;
    harness.appState.isBriefOnly = true;
    harness.appState.viewingAgentTaskId = "teammate-1";
    harness.appState.tasks = {
      "teammate-1": teammate(),
    };

    const output = await renderToText(
      <SpinnerWithVerb {...spinnerProps({ overrideMessage: "Leader work" })} />,
    );

    expect(output).toContain("ROW|responding|Working");
    expect(output).toContain("tokens:0");
    expect(output).toContain("teammates:true");
    expect(output).not.toContain("Leader work");
  });

  test("uses env-enabled brief mode with reconnecting status", async () => {
    vi.stubEnv("AGENC_BRIEF", "true");
    harness.featureFlags.add("KAIROS_BRIEF");
    harness.getUserMsgOptIn = true;
    harness.appState.isBriefOnly = true;
    harness.appState.remoteConnectionStatus = "reconnecting";
    harness.appState.remoteBackgroundTaskCount = 2;
    harness.spinnerVerbs = [];

    const output = await renderToText(<SpinnerWithVerb {...spinnerProps()} />);

    expect(output).toContain("Reconnecting");
    expect(output).toContain("2 in background");
    expect(harness.activity.started).toContain("spinner-responding");
  });

  test("renders active local agents without replacing the normal spinner row", async () => {
    harness.localAgents = [
      { id: "agent-1", summary: "Indexing" },
      { id: "agent-2", summary: "Testing" },
    ];
    harness.settings = {
      prefersReducedMotion: false,
      spinnerTipsEnabled: false,
    };

    const output = await renderToText(
      <SpinnerWithVerb
        {...spinnerProps({
          loadingStartTimeRef: makeRef(Date.now() - 1_900_000),
        })}
      />,
    );

    // With no real task, the leader's fallback is the honest phase label
    // ("Responding") rather than a random flavor verb.
    expect(output).toContain("ROW|responding|Responding");
    expect(output).toContain("Indexing, Testing");
    expect(output).not.toContain("Tip: Use /clear");
  });

  test("falls back to the first pending task when every pending task is blocked", async () => {
    harness.featureFlags.add("TOKEN_BUDGET");
    harness.currentTurnTokenBudget = 4_000;
    harness.outputTokens = 3_000;
    harness.tasksV2 = [
      {
        blockedBy: [],
        id: "current",
        status: "running",
        subject: "Reviewing plan",
      },
      {
        blockedBy: ["current"],
        id: "first-pending",
        status: "pending",
        subject: "first blocked",
      },
      {
        blockedBy: ["first-pending"],
        id: "second-pending",
        status: "pending",
        subject: "second blocked",
      },
    ];

    const output = await renderToText(
      <SpinnerWithVerb
        {...spinnerProps({
          loadingStartTimeRef: makeRef(Date.now() - 20_000),
          pauseStartTimeRef: makeRef(Date.now() - 4_000),
          totalPausedMsRef: makeRef(1_000),
        })}
      />,
    );

    expect(output).toContain("ROW|responding|Reviewing plan");
    expect(output).toContain("Next: first blocked");
    expect(output).toContain("Target: 3.0k / 4.0k (75%)");
  });

  test("prefers plural local agent idle text over background counts", async () => {
    harness.appState.remoteConnectionStatus = "disconnected";
    harness.appState.remoteBackgroundTaskCount = 5;
    harness.localAgents = [
      { id: "agent-1", summary: "Indexing" },
      { id: "agent-2", summary: "Testing" },
    ];

    const output = await renderToText(<BriefIdleStatus />);

    expect(output).toContain("Disconnected");
    expect(output).toContain("2 agents running");
    expect(output).not.toContain("5 in background");
  });
});
