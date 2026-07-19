import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { Text } from "../../ink.js";
import { createRoot } from "../../ink/root.js";
import { PromptInputFooterLeftSide } from "./PromptInputFooterLeftSide.js";

const footerMock = vi.hoisted(() => ({
  appState: {
    expandedView: "none" as "none" | "tasks" | "teammates",
    notifications: { current: null as null | { key: string } },
    remoteSessionUrl: undefined as string | undefined,
    tasks: {} as Record<string, any>,
    teamContext: undefined as undefined | { teammates: Record<string, { name: string }> },
    viewingAgentTaskId: undefined as string | undefined,
    viewSelectionMode: "normal",
  },
  copyOnSelect: true,
  featureFlags: new Set<string>(),
  fullscreen: false,
  globalConfig: {
    editorMode: "normal",
    prStatusFooterEnabled: true,
    tui: { vimMode: false },
  } as Record<string, any>,
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
  selectionState: { lastPressHadAlt: false } as { lastPressHadAlt?: boolean },
  swarmsEnabled: false,
  tasksV2: undefined as undefined | Array<Record<string, unknown>>,
  terminalColumns: 100,
}));

vi.mock("bun:bundle", () => ({
  feature: (name: string) => footerMock.featureFlags.has(name),
}));

vi.mock("../../../coordinator/coordinatorMode.js", () => ({
  isCoordinatorMode: () => footerMock.isCoordinator,
}));

vi.mock("../../keybindings/useShortcutDisplay.js", () => ({
  useShortcutDisplay: (_id: string, _scope: string, fallback: string) => fallback,
}));

vi.mock("../../../utils/config.js", () => ({
  getGlobalConfig: () => footerMock.globalConfig,
}));

vi.mock("../../../utils/permissions/PermissionMode.js", () => ({
  getModeColor: () => "mode",
  isDefaultMode: (mode: string | undefined) => mode === undefined || mode === "default",
}));

vi.mock("../tasks/BackgroundTaskStatus.js", () => ({
  BackgroundTaskStatus: (props: {
    isLeaderIdle?: boolean;
    isViewingTeammate?: boolean;
    tasksSelected?: boolean;
    teammateFooterIndex?: number;
  }) => (
    <Text>
      TASKS selected:{String(props.tasksSelected)} viewing:{String(props.isViewingTeammate)} idle:{String(props.isLeaderIdle)} index:{String(props.teammateFooterIndex)}
    </Text>
  ),
}));

vi.mock("../../../tasks/types.js", () => ({
  isBackgroundTask: (task: any) =>
    task?.type === "background_task" || task?.type === "in_process_teammate",
}));

vi.mock("../tasks/taskStatusUtils.js", () => ({
  shouldHideTasksFooter: (tasks: Record<string, any>, showSpinnerTree: boolean) =>
    showSpinnerTree && Object.values(tasks).some(task => task.type === "in_process_teammate"),
}));

vi.mock("../../../utils/agentSwarmsEnabled.js", () => ({
  isAgentSwarmsEnabled: () => footerMock.swarmsEnabled,
}));

vi.mock("../teams/TeamStatus.js", () => ({
  TeamStatus: (props: { showHint?: boolean; teamsSelected?: boolean }) => (
    <Text>TEAM selected:{String(props.teamsSelected)} hint:{String(props.showHint)}</Text>
  ),
}));

vi.mock("../../../utils/swarm/backends/registry.js", () => ({
  isInProcessEnabled: () => footerMock.inProcessEnabled,
}));

vi.mock("../../state/AppState.js", () => ({
  useAppState: (selector: (state: typeof footerMock.appState) => unknown) =>
    selector(footerMock.appState),
  useAppStateStore: () => ({
    getState: () => ({ remoteSessionUrl: footerMock.appState.remoteSessionUrl }),
  }),
}));

vi.mock("../../../bootstrap/state.js", () => ({
  flushInteractionTime: () => {},
  getIsRemoteMode: () => footerMock.isRemoteMode,
}));

vi.mock("./HistorySearchInput.js", () => ({
  default: (props: { historyFailedMatch?: boolean; value: string }) => (
    <Text>SEARCH {props.value} failed:{String(props.historyFailedMatch)}</Text>
  ),
}));

vi.mock("../../hooks/usePrStatus.js", () => ({
  usePrStatus: () => footerMock.prStatus,
}));

vi.mock("../design-system/KeyboardShortcutHint.js", () => ({
  KeyboardShortcutHint: ({ action, shortcut }: { action: string; shortcut: string }) => (
    <Text>{shortcut} to {action}</Text>
  ),
}));

vi.mock("../design-system/Byline.js", () => ({
  Byline: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: footerMock.terminalColumns, rows: 24 }),
}));

vi.mock("../../hooks/useTasksV2.js", () => ({
  useTasksV2: () => footerMock.tasksV2,
}));

vi.mock("../../../utils/fullscreen.js", () => ({
  isFullscreenEnvEnabled: () => footerMock.fullscreen,
}));

vi.mock("../../ink/terminal.js", () => ({
  SYNC_OUTPUT_SUPPORTED: false,
  isXtermJs: () => footerMock.isXterm,
  shouldSkipMainScreenSyncMarkers: () => true,
  shouldUseMainScreenRewrite: () => false,
  supportsExtendedKeys: () => false,
  writeDiffToTerminal: (
    terminal: { stdout: { write: (chunk: string) => void } },
    diff: Array<{ content?: string; str?: string; type: string }>,
  ) => {
    terminal.stdout.write(
      diff
        .map(patch => (patch.type === "stdout" ? patch.content ?? "" : patch.type === "styleStr" ? patch.str ?? "" : ""))
        .join(""),
    );
  },
}));

vi.mock("../../ink/hooks/use-selection.js", () => ({
  useHasSelection: () => footerMock.hasSelection,
  useSelection: () => ({
    getState: () => footerMock.selectionState,
  }),
}));

vi.mock("../../../utils/platform.js", () => ({
  getPlatform: () => footerMock.platform,
}));

vi.mock("../PrBadge.js", () => ({
  PrBadge: ({ number, reviewState }: { number: number; reviewState?: string }) => (
    <Text>PR#{number}:{reviewState}</Text>
  ),
}));

vi.mock("./proactiveAdapter.js", () => ({
  getPromptInputProactiveNextTickAt: () => footerMock.proactiveNextTickAt,
  isPromptInputProactiveActive: () => footerMock.proactiveActive,
  subscribeToPromptInputProactiveChanges: () => () => {},
}));

function defaultProps(
  overrides: Partial<React.ComponentProps<typeof PromptInputFooterLeftSide>> = {},
): React.ComponentProps<typeof PromptInputFooterLeftSide> {
  return {
    exitMessage: { show: false },
    historyFailedMatch: false,
    historyQuery: "",
    isLoading: false,
    isSearching: false,
    mode: "prompt",
    setHistoryQuery: () => {},
    suppressHint: false,
    tasksSelected: false,
    teamsSelected: false,
    toolPermissionContext: { mode: "default" } as any,
    vimMode: undefined,
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
  (stdout as unknown as { columns: number }).columns = footerMock.terminalColumns;

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

beforeEach(() => {
  footerMock.appState.expandedView = "none";
  footerMock.appState.notifications = { current: null };
  footerMock.appState.remoteSessionUrl = undefined;
  footerMock.appState.tasks = {};
  footerMock.appState.teamContext = undefined;
  footerMock.appState.viewingAgentTaskId = undefined;
  footerMock.appState.viewSelectionMode = "normal";
  footerMock.copyOnSelect = true;
  footerMock.featureFlags.clear();
  footerMock.fullscreen = false;
  footerMock.globalConfig = {
    editorMode: "normal",
    prStatusFooterEnabled: true,
    tui: { vimMode: false },
  };
  footerMock.hasSelection = false;
  footerMock.inProcessEnabled = false;
  footerMock.isCoordinator = false;
  footerMock.isRemoteMode = false;
  footerMock.isXterm = false;
  footerMock.platform = "linux";
  footerMock.prStatus = { number: null, reviewState: null, url: null };
  footerMock.proactiveActive = false;
  footerMock.proactiveNextTickAt = null;
  footerMock.selectionState = { lastPressHadAlt: false };
  footerMock.swarmsEnabled = false;
  footerMock.tasksV2 = undefined;
  footerMock.terminalColumns = 100;
});

describe("PromptInputFooterLeftSide rendering", () => {
  test("prioritizes exit, paste, search, and vim states", async () => {
    await expect(
      renderToText(<PromptInputFooterLeftSide {...defaultProps({ exitMessage: { show: true, key: "ctrl-c" } })} />),
    ).resolves.toContain("Press the same key again to exit");

    await expect(
      renderToText(<PromptInputFooterLeftSide {...defaultProps({ isPasting: true })} />),
    ).resolves.toContain("Pasting text");

    await expect(
      renderToText(
        <PromptInputFooterLeftSide
          {...defaultProps({
            historyFailedMatch: true,
            historyQuery: "needle",
            isSearching: true,
          })}
        />,
      ),
    ).resolves.toContain("SEARCH needle failed:true");

    footerMock.globalConfig = { editorMode: "vim", tui: { vimMode: true } };
    await expect(
      renderToText(<PromptInputFooterLeftSide {...defaultProps({ vimMode: "NORMAL" })} />),
    ).resolves.toContain("-- NORMAL --");
  });

  test("renders bash mode, permission mode, remote, and PR status branches", async () => {
    await expect(
      renderToText(<PromptInputFooterLeftSide {...defaultProps({ mode: "bash" })} />),
    ).resolves.toContain("! for bash mode");

    await expect(
      renderToText(
        <PromptInputFooterLeftSide
          {...defaultProps({
            toolPermissionContext: { mode: "bypassPermissions" } as any,
          })}
        />,
      ),
    ).resolves.toContain("YOLO");

    footerMock.isRemoteMode = true;
    footerMock.appState.remoteSessionUrl = "https://example.invalid/session";
    footerMock.prStatus = {
      number: 12,
      reviewState: "approved",
      url: "https://example.invalid/pr/12",
    };
    const remoteOutput = await renderToText(
      <PromptInputFooterLeftSide
        {...defaultProps({
          toolPermissionContext: { mode: "bypassPermissions" } as any,
        })}
      />,
    );
    expect(remoteOutput).toContain("remote");
    expect(remoteOutput).toContain("PR#12:approved");
    expect(remoteOutput).not.toContain("YOLO");
  });

  test("renders task, team, teammate, and loading hints", async () => {
    footerMock.swarmsEnabled = true;
    footerMock.appState.teamContext = {
      teammates: {
        lead: { name: "team-lead" },
        reviewer: { name: "Reviewer" },
      },
    };
    footerMock.tasksV2 = [{ id: "task-1" }];
    let output = await renderToText(
      <PromptInputFooterLeftSide
        {...defaultProps({
          isLoading: true,
          teamsSelected: true,
        })}
      />,
    );
    expect(output).toContain("TEAM selected:true");
    // The footer must NOT repeat "esc to interrupt" — the spinner byline owns
    // that affordance (SpinnerAnimationRow). Revert-sensitive.
    expect(output).not.toContain("esc to interrupt");
    expect(output).toContain("ctrl+t to show tasks");

    footerMock.appState.tasks = {
      teammate: { status: "running", type: "in_process_teammate" },
    };
    output = await renderToText(
      <PromptInputFooterLeftSide
        {...defaultProps({
          isLoading: false,
          tasksSelected: true,
          teammateFooterIndex: 1,
        })}
      />,
    );
    expect(output).toContain("TASKS selected:true viewing:false idle:true index:1");
    expect(output).toContain("ctrl+t to show tasks");

    footerMock.appState.viewSelectionMode = "viewing-agent";
    footerMock.appState.viewingAgentTaskId = "teammate";
    footerMock.appState.tasks.teammate.status = "completed";
    output = await renderToText(<PromptInputFooterLeftSide {...defaultProps()} />);
    expect(output).toContain("viewing:true");
    expect(output).toContain("esc to return to team lead");
  });

  test("renders proactive, kill-agent, task-management, and selection hints", async () => {
    footerMock.featureFlags.add("PROACTIVE");
    footerMock.proactiveActive = true;
    footerMock.proactiveNextTickAt = Date.now() + 2_000;
    await expect(renderToText(<PromptInputFooterLeftSide {...defaultProps()} />)).resolves.toContain("waiting");

    footerMock.featureFlags.clear();
    footerMock.proactiveActive = false;
    footerMock.proactiveNextTickAt = null;
    footerMock.appState.tasks = {
      local: { status: "running", type: "local_agent" },
    };
    footerMock.appState.notifications = { current: null };
    await expect(renderToText(<PromptInputFooterLeftSide {...defaultProps()} />)).resolves.toContain(
      "ctrl+x ctrl+k to stop agents",
    );

    footerMock.appState.notifications = { current: { key: "kill-agents-confirm" } };
    await expect(renderToText(<PromptInputFooterLeftSide {...defaultProps()} />)).resolves.not.toContain(
      "stop agents",
    );

    footerMock.appState.notifications = { current: null };

    footerMock.fullscreen = true;
    footerMock.hasSelection = true;
    footerMock.copyOnSelect = false;
    footerMock.globalConfig.copyOnSelect = false;
    await expect(renderToText(<PromptInputFooterLeftSide {...defaultProps({ suppressHint: true })} />)).resolves.toContain(
      "ctrl+c to copy",
    );

    footerMock.copyOnSelect = true;
    footerMock.globalConfig.copyOnSelect = true;
    footerMock.isXterm = true;
    footerMock.platform = "macos";
    footerMock.selectionState = { lastPressHadAlt: true };
    await expect(renderToText(<PromptInputFooterLeftSide {...defaultProps({ suppressHint: true })} />)).resolves.toContain(
      "macOptionClickForcesSelection",
    );
  });

  test("keeps fullscreen footer height stable when no parts are visible", async () => {
    expect((await renderToText(<PromptInputFooterLeftSide {...defaultProps({ suppressHint: true })} />)).trim()).toBe("");

    footerMock.fullscreen = true;
    const output = await renderToText(<PromptInputFooterLeftSide {...defaultProps({ suppressHint: true })} />);
    expect(output.trim()).toBe("");
  });
});
