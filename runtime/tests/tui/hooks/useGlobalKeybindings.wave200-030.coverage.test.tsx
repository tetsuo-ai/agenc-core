import { PassThrough } from "node:stream";
import { createRequire } from "node:module";

import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Screen } from "../types/screen.js";

type ExpandedView = "none" | "tasks" | "teammates";

type AppState = {
  expandedView: ExpandedView;
  isBriefOnly: boolean;
  showTeammateMessagePreview?: boolean;
  tasks: Record<string, { status?: string; type?: string }>;
};

type CapturedKeybinding = {
  handler: () => void;
  options?: {
    context?: string;
    isActive?: boolean;
  };
};

const harness = vi.hoisted(() => ({
  appState: {
    expandedView: "none",
    isBriefOnly: false,
    showTeammateMessagePreview: false,
    tasks: {},
  } as AppState,
  briefEnabled: false,
  features: new Set<string>(),
  keybindings: new Map<string, CapturedKeybinding>(),
  setAppState: vi.fn(),
  terminalToggle: vi.fn(),
}));

vi.mock("bun:bundle", () => ({
  feature: (name: string) => harness.features.has(name),
}));

vi.mock("../keybindings/useKeybinding.js", () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options?: CapturedKeybinding["options"],
  ) => {
    harness.keybindings.set(action, { handler, options });
  },
}));

vi.mock("../state/AppState.js", () => ({
  useAppState: (selector: (state: AppState) => unknown) =>
    selector(harness.appState),
  useSetAppState: () => harness.setAppState,
}));

vi.mock("../../utils/terminalPanel.js", () => ({
  getTerminalPanel: () => ({
    toggle: harness.terminalToggle,
  }),
}));

import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import { GlobalKeybindingHandlers } from "./useGlobalKeybindings.js";

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  readonly stdout: PassThrough;
};

function createStreams(): TestStreams {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStreams["stdin"];

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

function keybinding(action: string): CapturedKeybinding {
  const binding = harness.keybindings.get(action);
  if (!binding) throw new Error(`missing keybinding: ${action}`);
  return binding;
}

const requireForTest = createRequire(import.meta.url);
const moduleLoader = requireForTest("node:module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

function installLazyRequireMocks(): () => void {
  const originalLoad = moduleLoader._load;

  moduleLoader._load = ((request: string, parent: unknown, isMain: boolean) => {
    if (
      request === "../../tasks/InProcessTeammateTask/InProcessTeammateTask"
    ) {
      return {
        getAllInProcessTeammateTasks: (
          tasks: Record<string, { status?: string; type?: string }>,
        ) =>
          Object.values(tasks).filter(
            task => task.type === "in_process_teammate",
          ),
      };
    }

    if (request === "../../tools/BriefTool/BriefTool") {
      return {
        isBriefEnabled: () => harness.briefEnabled,
      };
    }

    return Reflect.apply(originalLoad, moduleLoader, [request, parent, isMain]);
  }) as typeof originalLoad;

  return () => {
    moduleLoader._load = originalLoad;
  };
}

describe("GlobalKeybindingHandlers wave200 coverage", () => {
  beforeEach(() => {
    harness.appState = {
      expandedView: "none",
      isBriefOnly: false,
      showTeammateMessagePreview: false,
      tasks: {},
    };
    harness.briefEnabled = false;
    harness.features = new Set(["KAIROS_BRIEF", "TERMINAL_PANEL"]);
    harness.keybindings = new Map();
    vi.clearAllMocks();
    harness.setAppState.mockImplementation(
      (update: AppState | ((prev: AppState) => AppState)) => {
        harness.appState =
          typeof update === "function" ? update(harness.appState) : update;
      },
    );
  });

  test("runs registered global and transcript callbacks against app state", async () => {
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    const restoreLazyRequireMocks = installLazyRequireMocks();
    const previousStdoutInstance = instances.get(process.stdout);
    const forceRedraw = vi.fn();

    let screen: Screen = "prompt";
    let showAllInTranscript = true;
    const onEnterTranscript = vi.fn();
    const onExitTranscript = vi.fn();
    const setScreen = vi.fn((next: React.SetStateAction<Screen>) => {
      screen = typeof next === "function" ? next(screen) : next;
    });
    const setShowAllInTranscript = vi.fn(
      (next: React.SetStateAction<boolean>) => {
        showAllInTranscript =
          typeof next === "function" ? next(showAllInTranscript) : next;
      },
    );

    const renderHandlers = async () => {
      root.render(
        <GlobalKeybindingHandlers
          screen={screen}
          setScreen={setScreen}
          showAllInTranscript={showAllInTranscript}
          setShowAllInTranscript={setShowAllInTranscript}
          messageCount={5}
          onEnterTranscript={onEnterTranscript}
          onExitTranscript={onExitTranscript}
        />,
      );
      await sleep();
    };

    try {
      instances.set(process.stdout, { forceRedraw } as never);
      harness.appState.tasks = {
        teammate: {
          status: "running",
          type: "in_process_teammate",
        },
      };

      await renderHandlers();
      keybinding("app:toggleTodos").handler();
      expect(harness.appState.expandedView).toBe("tasks");

      await renderHandlers();
      keybinding("app:toggleTodos").handler();
      expect(harness.appState.expandedView).toBe("teammates");

      await renderHandlers();
      keybinding("app:toggleTodos").handler();
      expect(harness.appState.expandedView).toBe("none");

      harness.appState.tasks = {};
      harness.appState.expandedView = "tasks";
      await renderHandlers();
      keybinding("app:toggleTodos").handler();
      expect(harness.appState.expandedView).toBe("none");

      await renderHandlers();
      keybinding("app:toggleTodos").handler();
      expect(harness.appState.expandedView).toBe("tasks");

      harness.appState.isBriefOnly = true;
      harness.briefEnabled = false;
      screen = "prompt";
      showAllInTranscript = true;
      setScreen.mockClear();
      setShowAllInTranscript.mockClear();
      await renderHandlers();
      keybinding("app:toggleTranscript").handler();
      expect(harness.appState.isBriefOnly).toBe(false);
      expect(setScreen).not.toHaveBeenCalled();
      expect(setShowAllInTranscript).not.toHaveBeenCalled();

      await renderHandlers();
      keybinding("app:toggleTranscript").handler();
      expect(screen).toBe("transcript");
      expect(showAllInTranscript).toBe(false);
      expect(onEnterTranscript).toHaveBeenCalledTimes(1);

      showAllInTranscript = false;
      await renderHandlers();
      expect(keybinding("transcript:toggleShowAll").options).toEqual({
        context: "Transcript",
        isActive: true,
      });
      expect(keybinding("transcript:exit").options).toEqual({
        context: "Transcript",
        isActive: true,
      });
      keybinding("transcript:toggleShowAll").handler();
      expect(showAllInTranscript).toBe(true);

      keybinding("transcript:exit").handler();
      expect(screen).toBe("prompt");
      expect(showAllInTranscript).toBe(false);
      expect(onExitTranscript).toHaveBeenCalledTimes(1);

      harness.appState.isBriefOnly = false;
      harness.briefEnabled = false;
      await renderHandlers();
      keybinding("app:toggleBrief").handler();
      expect(harness.appState.isBriefOnly).toBe(false);

      harness.briefEnabled = true;
      await renderHandlers();
      keybinding("app:toggleBrief").handler();
      expect(harness.appState.isBriefOnly).toBe(true);

      keybinding("app:toggleTeammatePreview").handler();
      expect(harness.appState.showTeammateMessagePreview).toBe(true);

      keybinding("app:redraw").handler();
      expect(forceRedraw).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      if (previousStdoutInstance) {
        instances.set(process.stdout, previousStdoutInstance);
      } else {
        instances.delete(process.stdout);
      }
      restoreLazyRequireMocks();
      await sleep();
    }
  });
});
