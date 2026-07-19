import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  appState: {
    expandedView: "none" as "none" | "tasks" | "teammates",
    notifications: { current: null as null | { key: string } },
    remoteSessionUrl: undefined as string | undefined,
    tasks: {} as Record<string, unknown>,
    teamContext: undefined as
      | undefined
      | { teammates: Record<string, { name: string }> },
    viewingAgentTaskId: undefined as string | undefined,
    viewSelectionMode: "none",
  },
  columns: 100,
  config: {
    copyOnSelect: true as boolean | undefined,
    editorMode: "normal",
    prStatusFooterEnabled: true as boolean | undefined,
  },
  features: new Set<string>(),
  fullscreen: false,
  hasSelection: false,
  inProcessEnabled: false,
  isCoordinator: false,
  isRemoteMode: false,
  isXterm: false,
  platform: "linux",
  prStatus: {
    number: null as number | null,
    reviewState: null as string | null,
    url: null as string | null,
  },
  proactiveActive: false,
  proactiveNextTickAt: null as number | null,
  selectionState: { lastPressHadAlt: false },
  swarmsEnabled: false,
  tasksV2: undefined as undefined | Array<{ id: string; subject: string }>,
  reset() {
    harness.appState = {
      expandedView: "none",
      notifications: { current: null },
      remoteSessionUrl: undefined,
      tasks: {},
      teamContext: undefined,
      viewingAgentTaskId: undefined,
      viewSelectionMode: "none",
    };
    harness.columns = 100;
    harness.config = {
      copyOnSelect: true,
      editorMode: "normal",
      prStatusFooterEnabled: true,
    };
    harness.features = new Set();
    harness.fullscreen = false;
    harness.hasSelection = false;
    harness.inProcessEnabled = false;
    harness.isCoordinator = false;
    harness.isRemoteMode = false;
    harness.isXterm = false;
    harness.platform = "linux";
    harness.prStatus = {
      number: null,
      reviewState: null,
      url: null,
    };
    harness.proactiveActive = false;
    harness.proactiveNextTickAt = null;
    harness.selectionState = { lastPressHadAlt: false };
    harness.swarmsEnabled = false;
    harness.tasksV2 = undefined;
  },
}));

vi.mock("bun:bundle", () => ({
  feature: (name: string) => harness.features.has(name),
}));

vi.mock("../../../coordinator/coordinatorMode.js", () => ({
  isCoordinatorMode: () => harness.isCoordinator,
}));

vi.mock("../../keybindings/useShortcutDisplay.js", () => ({
  useShortcutDisplay: (command: string) => {
    if (command === "chat:cycleMode") return "shift+tab";
    if (command === "chat:cancel") return "esc";
    if (command === "app:toggleTodos") return "ctrl+t";
    if (command === "chat:killAgents") return "ctrl+x ctrl+k";
    return command;
  },
}));

vi.mock("../tasks/BackgroundTaskStatus.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");
  return {
    BackgroundTaskStatus: (props: Record<string, unknown>) =>
      ReactModule.createElement(
        Text,
        null,
        `Tasks:${String(props.tasksSelected)}:${String(props.isViewingTeammate)}:${String(props.isLeaderIdle)}:${String(props.teammateFooterIndex ?? "none")}`,
      ),
  };
});

vi.mock("../CoordinatorAgentStatus.js", () => ({
  getVisibleAgentTasks: () => [],
}));

vi.mock("../teams/TeamStatus.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");
  return {
    TeamStatus: (props: Record<string, unknown>) =>
      ReactModule.createElement(
        Text,
        null,
        `Teams:${String(props.teamsSelected)}:${String(props.showHint)}`,
      ),
  };
});

vi.mock("../../../tasks/types.js", () => ({
  isBackgroundTask: (task: { readonly type?: string; readonly status?: string }) =>
    task.type === "background" && task.status !== "completed",
}));

vi.mock("../tasks/taskStatusUtils.js", () => ({
  shouldHideTasksFooter: () => false,
}));

vi.mock("../../../utils/agentSwarmsEnabled.js", () => ({
  isAgentSwarmsEnabled: () => harness.swarmsEnabled,
}));

vi.mock("../../../utils/swarm/backends/registry.js", () => ({
  isInProcessEnabled: () => harness.inProcessEnabled,
}));

vi.mock("../../state/AppState.js", () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
  useAppStateStore: () => ({ getState: () => harness.appState }),
}));

vi.mock("../../../bootstrap/state.js", () => ({
  flushInteractionTime: vi.fn(),
  getIsRemoteMode: () => harness.isRemoteMode,
}));

vi.mock("./HistorySearchInput.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");
  return {
    default: (props: Record<string, unknown>) =>
      ReactModule.createElement(
        Text,
        null,
        `History:${String(props.value)}:${String(props.historyFailedMatch)}`,
      ),
  };
});

vi.mock("../../hooks/usePrStatus.js", () => ({
  usePrStatus: () => harness.prStatus,
}));

vi.mock("../design-system/KeyboardShortcutHint.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");
  return {
    KeyboardShortcutHint: ({
      action,
      shortcut,
    }: {
      readonly action: string;
      readonly shortcut: string;
    }) => ReactModule.createElement(Text, null, `${shortcut} ${action}`),
  };
});

vi.mock("../design-system/Byline.js", async () => {
  const ReactModule = await import("react");
  return {
    Byline: ({ children }: { readonly children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

vi.mock("../../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: harness.columns, rows: 24 }),
}));

vi.mock("../../hooks/useTasksV2.js", () => ({
  useTasksV2: () => harness.tasksV2,
}));

vi.mock("../../../utils/fullscreen.js", () => ({
  isFullscreenEnvEnabled: () => harness.fullscreen,
}));

vi.mock("../../ink/terminal.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../ink/terminal.js")>();
  return {
    ...actual,
    isXtermJs: () => harness.isXterm,
  };
});

vi.mock("../../ink/hooks/use-selection.js", () => ({
  useHasSelection: () => harness.hasSelection,
  useSelection: () => ({ getState: () => harness.selectionState }),
}));

vi.mock("../../../utils/config.js", () => ({
  getGlobalConfig: () => harness.config,
}));

vi.mock("../../../utils/platform.js", () => ({
  getPlatform: () => harness.platform,
}));

vi.mock("../PrBadge.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../ink.js");
  return {
    PrBadge: (props: Record<string, unknown>) =>
      ReactModule.createElement(
        Text,
        null,
        `PR:${String(props.number)}:${String(props.reviewState)}`,
      ),
  };
});

vi.mock("./proactiveAdapter.js", () => ({
  getPromptInputProactiveNextTickAt: () => harness.proactiveNextTickAt,
  isPromptInputProactiveActive: () => harness.proactiveActive,
  subscribeToPromptInputProactiveChanges: () => () => {},
}));

import { createRoot } from "../../ink.js";
import { PromptInputFooterLeftSide } from "./PromptInputFooterLeftSide.js";

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

async function renderFooter(
  overrides: Partial<React.ComponentProps<typeof PromptInputFooterLeftSide>> = {},
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
  root.render(
    <PromptInputFooterLeftSide
      exitMessage={{ show: false }}
      historyFailedMatch={false}
      historyQuery=""
      isLoading={false}
      isSearching={false}
      mode="prompt"
      setHistoryQuery={vi.fn()}
      suppressHint={false}
      tasksSelected={false}
      teamsSelected={false}
      toolPermissionContext={{ mode: "default" } as never}
      vimMode={undefined}
      {...overrides}
    />,
  );
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

describe("PromptInputFooterLeftSide render paths", () => {
  beforeEach(() => {
    harness.reset();
  });

  test("renders exit and paste priority messages before mode hints", async () => {
    const exit = await renderFooter({ exitMessage: { key: "ctrl+c", show: true } });
    try {
      expect(exit.output()).toContain("Press the same key again to exit");
    } finally {
      await exit.dispose();
    }

    const paste = await renderFooter({ isPasting: true });
    try {
      expect(paste.output()).toContain("Pasting text");
    } finally {
      await paste.dispose();
    }
  });

  test("renders history search, vim mode, and bash mode states", async () => {
    const search = await renderFooter({
      historyFailedMatch: true,
      historyQuery: "needle",
      isSearching: true,
      vimMode: "INSERT",
    });
    try {
      expect(search.output()).toContain("History:needle:true");
      expect(search.output()).not.toContain("-- INSERT --");
    } finally {
      await search.dispose();
    }

    harness.config.editorMode = "vim";
    const vim = await renderFooter({ vimMode: "NORMAL" });
    try {
      expect(vim.output()).toContain("-- NORMAL --");
    } finally {
      await vim.dispose();
    }

    const bash = await renderFooter({ mode: "bash" });
    try {
      expect(bash.output()).toContain("! for bash mode");
    } finally {
      await bash.dispose();
    }
  });

  test("renders permission, task, team, pr, and shortcut hints", async () => {
    harness.appState.tasks = {
      background: { status: "running", type: "background" },
    };
    harness.appState.teamContext = {
      teammates: {
        fixer: { name: "Fixer" },
        lead: { name: "team-lead" },
      },
    };
    harness.prStatus = {
      number: 42,
      reviewState: "changes_requested",
      url: "https://example.test/pr/42",
    };
    harness.swarmsEnabled = true;
    harness.tasksV2 = [{ id: "task-1", subject: "do work" }];

    const rendered = await renderFooter({
      isLoading: true,
      tasksSelected: true,
      teamsSelected: true,
      toolPermissionContext: { mode: "bypassPermissions" } as never,
    });

    try {
      const output = rendered.output();
      expect(output).toContain("YOLO");
      expect(output).toContain("Tasks:true:false:false:none");
      expect(output).toContain("Teams:true:false");
      expect(output).not.toContain("PR:42");
      // The footer must NOT repeat the spinner byline's "esc to interrupt".
      expect(output).not.toContain("esc interrupt");
    } finally {
      await rendered.dispose();
    }
  });

  test("renders teammate pill rows and completed-teammate return hint", async () => {
    harness.appState.tasks = {
      teammate: {
        status: "completed",
        type: "in_process_teammate",
      },
    };
    harness.appState.viewingAgentTaskId = "teammate";
    harness.appState.viewSelectionMode = "viewing-agent";

    const rendered = await renderFooter({
      teammateFooterIndex: 2,
      toolPermissionContext: { mode: "acceptEdits" } as never,
    });

    try {
      const output = rendered.output();
      expect(output).toContain("Tasks:false:true:true:2");
      expect(output).toContain("esc return to team lead");
      expect(output).toContain("accept edits on");
    } finally {
      await rendered.dispose();
    }
  });

  test("renders proactive countdown and fullscreen selection guidance", async () => {
    harness.features.add("PROACTIVE");
    harness.proactiveActive = true;
    harness.proactiveNextTickAt = Date.now() + 3000;

    const proactive = await renderFooter();
    try {
      expect(proactive.output()).toContain("waiting");
    } finally {
      await proactive.dispose();
    }

    harness.features = new Set();
    harness.fullscreen = true;
    harness.hasSelection = true;
    harness.isXterm = true;
    harness.platform = "macos";
    harness.selectionState = { lastPressHadAlt: true };
    const selection = await renderFooter({ suppressHint: true });
    try {
      expect(selection.output()).toContain(
        "set macOptionClickForcesSelection in VS Code settings",
      );
    } finally {
      await selection.dispose();
    }

    harness.config.copyOnSelect = false;
    harness.isXterm = false;
    harness.platform = "linux";
    const copy = await renderFooter({ suppressHint: true });
    try {
      expect(copy.output()).toContain("ctrl+c copy");
    } finally {
      await copy.dispose();
    }
  });

  test("reserves a fullscreen row when all footer parts are suppressed", async () => {
    harness.fullscreen = true;
    const rendered = await renderFooter({ suppressHint: true });
    try {
      expect(rendered.output().trim()).toBe("");
    } finally {
      await rendered.dispose();
    }
  });
});
