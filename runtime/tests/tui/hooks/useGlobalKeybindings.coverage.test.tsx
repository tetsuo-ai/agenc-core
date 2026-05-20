import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

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
  },
  features: new Set<string>(),
  growthbookCalls: [] as Array<{ fallback: boolean; key: string }>,
  keybindings: new Map<string, CapturedKeybinding>(),
  logEvent: vi.fn(),
  setAppState: vi.fn(),
  terminalAllowed: false,
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
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
  useSetAppState: () => harness.setAppState,
}));

vi.mock("../../services/analytics/index.js", () => ({
  logEvent: harness.logEvent,
}));

vi.mock("../../services/analytics/growthbook.js", () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (key: string, fallback: boolean) => {
    harness.growthbookCalls.push({ fallback, key });
    return key === "agenc_terminal_panel" ? harness.terminalAllowed : fallback;
  },
}));

vi.mock("../../utils/terminalPanel.js", () => ({
  getTerminalPanel: () => ({
    toggle: harness.terminalToggle,
  }),
}));

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

describe("GlobalKeybindingHandlers", () => {
  beforeEach(() => {
    harness.features = new Set(["TERMINAL_PANEL"]);
    harness.growthbookCalls = [];
    harness.keybindings = new Map();
    harness.terminalAllowed = false;
    vi.clearAllMocks();
  });

  test("gates transcript bindings and terminal panel toggle on their active states", async () => {
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <GlobalKeybindingHandlers
          screen="transcript"
          setScreen={
            vi.fn() as React.Dispatch<
              React.SetStateAction<"prompt" | "transcript">
            >
          }
          showAllInTranscript={false}
          setShowAllInTranscript={
            vi.fn() as React.Dispatch<React.SetStateAction<boolean>>
          }
          messageCount={3}
          virtualScrollActive={true}
          searchBarOpen={true}
        />,
      );
      await sleep();

      expect(harness.keybindings.get("transcript:toggleShowAll")?.options).toEqual(
        {
          context: "Transcript",
          isActive: false,
        },
      );
      expect(harness.keybindings.get("transcript:exit")?.options).toEqual({
        context: "Transcript",
        isActive: false,
      });

      const toggleTerminal = harness.keybindings.get("app:toggleTerminal")
        ?.handler;
      expect(toggleTerminal).toBeDefined();

      toggleTerminal?.();
      expect(harness.growthbookCalls).toEqual([
        { fallback: false, key: "agenc_terminal_panel" },
      ]);
      expect(harness.terminalToggle).not.toHaveBeenCalled();

      harness.terminalAllowed = true;
      toggleTerminal?.();
      expect(harness.growthbookCalls).toEqual([
        { fallback: false, key: "agenc_terminal_panel" },
        { fallback: false, key: "agenc_terminal_panel" },
      ]);
      expect(harness.terminalToggle).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
