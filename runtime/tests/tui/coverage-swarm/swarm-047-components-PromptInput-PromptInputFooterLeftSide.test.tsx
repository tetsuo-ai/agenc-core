import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test, vi } from "vitest";

const footerState = vi.hoisted(() => ({
  appState: {
    expandedView: "none" as "none" | "tasks" | "teammates",
    notifications: { current: null as null | { key: string } },
    remoteSessionUrl: undefined as string | undefined,
    tasks: {} as Record<string, unknown>,
    teamContext: undefined as
      | undefined
      | { teammates: Record<string, { name: string }> },
    viewingAgentTaskId: undefined as string | undefined,
    viewSelectionMode: "normal",
  },
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../../../src/coordinator/coordinatorMode.js", () => ({
  isCoordinatorMode: () => false,
}));

vi.mock("../../../src/tui/keybindings/useShortcutDisplay.js", () => ({
  useShortcutDisplay: (_id: string, _scope: string, fallback: string) => fallback,
}));

vi.mock("../../../src/utils/config.js", () => ({
  getGlobalConfig: () => ({
    copyOnSelect: true,
    editorMode: "normal",
    prStatusFooterEnabled: true,
    tui: { vimMode: false },
  }),
}));

vi.mock("../../../src/utils/permissions/PermissionMode.js", () => ({
  getModeColor: () => "mode",
  isDefaultMode: (mode: string | undefined) =>
    mode === undefined || mode === "default",
}));

vi.mock("../../../src/tui/components/tasks/BackgroundTaskStatus.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../../src/tui/ink.js");

  return {
    BackgroundTaskStatus: () => ReactModule.createElement(Text, null, "tasks"),
  };
});

vi.mock("../../../src/tasks/types.js", () => ({
  isBackgroundTask: () => false,
}));

vi.mock("../../../src/tui/components/CoordinatorAgentStatus.js", () => ({
  getVisibleAgentTasks: () => [],
}));

vi.mock("../../../src/tui/components/tasks/taskStatusUtils.js", () => ({
  shouldHideTasksFooter: () => false,
}));

vi.mock("../../../src/utils/agentSwarmsEnabled.js", () => ({
  isAgentSwarmsEnabled: () => false,
}));

vi.mock("../../../src/tui/components/teams/TeamStatus.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../../src/tui/ink.js");

  return {
    TeamStatus: () => ReactModule.createElement(Text, null, "team"),
  };
});

vi.mock("../../../src/utils/swarm/backends/registry.js", () => ({
  isInProcessEnabled: () => false,
}));

vi.mock("../../../src/tui/state/AppState.js", () => ({
  useAppState: (selector: (state: typeof footerState.appState) => unknown) =>
    selector(footerState.appState),
  useAppStateStore: () => ({
    getState: () => footerState.appState,
  }),
}));

vi.mock("../../../src/bootstrap/state.js", () => ({
  flushInteractionTime: () => {},
  getIsRemoteMode: () => false,
}));

vi.mock("../../../src/tui/components/PromptInput/HistorySearchInput.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../../src/tui/ink.js");

  return {
    default: () => ReactModule.createElement(Text, null, "history-search"),
  };
});

vi.mock("../../../src/tui/hooks/usePrStatus.js", () => ({
  usePrStatus: () => ({
    number: null,
    reviewState: null,
    url: null,
  }),
}));

vi.mock("../../../src/tui/components/design-system/KeyboardShortcutHint.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../../src/tui/ink.js");

  return {
    KeyboardShortcutHint: ({
      action,
      shortcut,
    }: {
      readonly action: string;
      readonly shortcut: string;
    }) => ReactModule.createElement(Text, null, `${shortcut} to ${action}`),
  };
});

vi.mock("../../../src/tui/components/design-system/Byline.js", async () => {
  const ReactModule = await import("react");

  return {
    Byline: ({ children }: { readonly children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

vi.mock("../../../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 100, rows: 24 }),
}));

vi.mock("../../../src/tui/hooks/useTasksV2.js", () => ({
  useTasksV2: () => undefined,
}));

vi.mock("../../../src/utils/fullscreen.js", () => ({
  isFullscreenEnvEnabled: () => false,
}));

vi.mock("../../../src/tui/ink/terminal.js", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../../src/tui/ink/terminal.js")>();

  return {
    ...actual,
    SYNC_OUTPUT_SUPPORTED: false,
    isXtermJs: () => false,
    shouldSkipMainScreenSyncMarkers: () => true,
    shouldUseMainScreenRewrite: () => false,
    supportsExtendedKeys: () => false,
    writeDiffToTerminal: (
      terminal: { stdout: { write: (chunk: string) => void } },
      diff: Array<{ content?: string; str?: string; type: string }>,
    ) => {
      terminal.stdout.write(
        diff
          .map(patch =>
            patch.type === "stdout"
              ? patch.content ?? ""
              : patch.type === "styleStr"
                ? patch.str ?? ""
                : "",
          )
          .join(""),
      );
    },
  };
});

vi.mock("../../../src/tui/ink/hooks/use-selection.js", () => ({
  useHasSelection: () => false,
  useSelection: () => ({
    getState: () => ({ lastPressHadAlt: false }),
  }),
}));

vi.mock("../../../src/utils/platform.js", () => ({
  getPlatform: () => "linux",
}));

vi.mock("../../../src/tui/components/PrBadge.js", async () => {
  const ReactModule = await import("react");
  const { Text } = await import("../../../src/tui/ink.js");

  return {
    PrBadge: () => ReactModule.createElement(Text, null, "pr"),
  };
});

vi.mock("../../../src/tui/components/PromptInput/proactiveAdapter.js", () => ({
  getPromptInputProactiveNextTickAt: () => null,
  isPromptInputProactiveActive: () => false,
  subscribeToPromptInputProactiveChanges: () => () => {},
}));

import { createRoot } from "../../../src/tui/ink.js";
import { PromptInputFooterLeftSide } from "../../../src/tui/components/PromptInput/PromptInputFooterLeftSide.js";

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

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: TestStdout;
} {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough() as TestStdout;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  stdout.columns = 100;
  stdout.rows = 24;
  stdout.isTTY = true;
  stdout.resume();

  return { stdin, stdout };
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("PromptInputFooterLeftSide coverage swarm 047", () => {
  test("reuses memoized footer fragments across identical rerenders", async () => {
    const { stdin, stdout } = createStreams();
    let output = "";

    stdout.on("data", chunk => {
      output += chunk.toString();
    });

    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    const setHistoryQuery = vi.fn();
    const toolPermissionContext = { mode: "default" } as never;
    const props: React.ComponentProps<typeof PromptInputFooterLeftSide> = {
      exitMessage: { show: false },
      historyFailedMatch: false,
      historyQuery: "",
      isLoading: false,
      isSearching: false,
      mode: "prompt",
      setHistoryQuery,
      suppressHint: false,
      tasksSelected: false,
      teamsSelected: false,
      toolPermissionContext,
      vimMode: undefined,
    };

    try {
      root.render(<PromptInputFooterLeftSide {...props} />);
      await sleep();
      root.render(<PromptInputFooterLeftSide {...props} />);
      await sleep();

      expect(stripAnsi(output)).toContain("?forshortcuts");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
