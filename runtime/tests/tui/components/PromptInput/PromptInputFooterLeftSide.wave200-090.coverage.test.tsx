import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  appState: {
    expandedView: "none" as "none" | "tasks" | "teammates",
    notifications: { current: null as null | { key: string } },
    remoteSessionUrl: undefined as string | undefined,
    tasks: {} as Record<string, { status?: string; type?: string }>,
    teamContext: undefined as
      | undefined
      | { teammates: Record<string, { name: string }> },
    viewingAgentTaskId: undefined as string | undefined,
    viewSelectionMode: "none",
  },
  columns: 100,
  config: {
    copyOnSelect: true as boolean | undefined,
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
    if (command === "chat:cancel") return "esc";
    if (command === "app:toggleTodos") return "ctrl+t";
    if (command === "chat:killAgents") return "ctrl+x ctrl+k";
    if (command === "chat:cycleMode") return "shift+tab";
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
        `task-pill:${String(props.tasksSelected)}:${String(props.isLeaderIdle)}`,
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
    TeamStatus: () => ReactModule.createElement(Text, null, "team-pill"),
  };
});

vi.mock("../../../tasks/types.js", () => ({
  isBackgroundTask: (task: { readonly status?: string }) =>
    task.status === "pending" || task.status === "running",
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
    default: () => ReactModule.createElement(Text, null, "history-search"),
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
    PrBadge: () => ReactModule.createElement(Text, null, "pr-pill"),
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
  readonly stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  readonly stdout: PassThrough;
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
  readonly dispose: () => Promise<void>;
  readonly output: () => string;
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

describe("PromptInputFooterLeftSide task hints", () => {
  beforeEach(() => {
    harness.reset();
  });

  test("renders task management and teammate toggle hints from task state", async () => {
    harness.appState.tasks = {
      worker: { status: "running", type: "local_agent" },
    };
    harness.tasksV2 = [{ id: "todo-1", subject: "follow up" }];

    const unselectedTasks = await renderFooter();
    try {
      expect(unselectedTasks.output()).toContain("task-pill:false:true");
      expect(unselectedTasks.output()).toContain("ctrl+x ctrl+k stop agents");
      // The inline AGENT FLEET panel was removed, so there is no ↓-to-manage hint.
    } finally {
      await unselectedTasks.dispose();
    }

    const selectedTasks = await renderFooter({ tasksSelected: true });
    try {
      expect(selectedTasks.output()).toContain("task-pill:true:true");
    } finally {
      await selectedTasks.dispose();
    }

    harness.appState.tasks = {
      teammate: { status: "running", type: "in_process_teammate" },
    };
    harness.tasksV2 = undefined;

    for (const [expandedView, expectedAction] of [
      ["none", "show tasks"],
      ["tasks", "show teammates"],
      ["teammates", "hide"],
    ] as const) {
      harness.appState.expandedView = expandedView;
      const rendered = await renderFooter();
      try {
        expect(rendered.output()).toContain(`ctrl+t ${expectedAction}`);
      } finally {
        await rendered.dispose();
      }
    }
  });
});
