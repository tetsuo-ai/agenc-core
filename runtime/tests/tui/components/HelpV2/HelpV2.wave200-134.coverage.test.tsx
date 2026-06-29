import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Command } from "../../../commands.js";

const keybindingMock = vi.hoisted(() => ({
  groups: [] as Array<{
    handlers: Record<string, () => void>;
    options: { context?: string; isActive?: boolean };
  }>,
  singles: [] as Array<{
    action: string;
    handler: () => void;
    options: { context?: string; isActive?: boolean };
  }>,
}));

const exitStateMock = vi.hoisted(() => ({
  state: {
    keyName: "ctrl+c",
    pending: true,
  },
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("src/tui/hooks/useExitOnCtrlCDWithKeybindings.js", () => ({
  useExitOnCtrlCDWithKeybindings: () => exitStateMock.state,
}));

vi.mock("../../keybindings/useShortcutDisplay.js", () => ({
  useShortcutDisplay: () => "esc",
}));

vi.mock("../../keybindings/useKeybinding.js", () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options: { context?: string; isActive?: boolean } = {},
  ) => {
    keybindingMock.singles.push({ action, handler, options });
  },
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { context?: string; isActive?: boolean } = {},
  ) => {
    keybindingMock.groups.push({ handlers, options });
  },
}));

vi.mock("../../keybindings/loadUserBindings.js", () => ({
  isKeybindingCustomizationEnabled: () => false,
}));

vi.mock("../../../utils/fastMode.js", () => ({
  isFastModeAvailable: () => false,
  isFastModeEnabled: () => false,
}));

vi.mock("../../../utils/platform.js", () => ({
  getPlatform: () => "linux",
}));

import { ModalContext } from "../../context/modalContext.js";
import { createRoot, type Root } from "../../ink.js";
import { HelpV2 } from "./HelpV2.js";

function sleep(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function testCommand(name: string, description: string): Command {
  return {
    type: "prompt",
    name,
    description,
    progressMessage: "running",
    contentLength: description.length,
  } as Command;
}

function invokeGroup(action: string): void {
  const registration = [...keybindingMock.groups]
    .reverse()
    .find(
      candidate =>
        candidate.handlers[action] !== undefined &&
        candidate.options.isActive !== false,
    );

  if (!registration) throw new Error(`No active keybinding group for ${action}`);
  registration.handlers[action]?.();
}

function createStreams(): {
  stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdout: PassThrough;
  output: () => string;
} {
  let rendered = "";
  const stdout = new PassThrough();
  stdout.on("data", chunk => {
    rendered += chunk.toString();
  });
  stdout.resume();
  (stdout as unknown as { columns: number; rows: number }).columns = 90;
  (stdout as unknown as { columns: number; rows: number }).rows = 18;

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

  return {
    stdin,
    stdout,
    output: () => stripAnsi(rendered),
  };
}

function renderNode(commands: Command[], onClose: () => void): React.ReactNode {
  return (
    <ModalContext.Provider
      value={{ rows: 18, columns: 90, scrollRef: null }}
    >
      <HelpV2 commands={commands} onClose={onClose} />
    </ModalContext.Provider>
  );
}

async function renderModalHelp(commands: Command[]): Promise<{
  dispose: () => void;
  onClose: ReturnType<typeof vi.fn>;
  output: () => string;
  rerender: () => Promise<void>;
  root: Root;
}> {
  const { stdin, stdout, output } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  const onClose = vi.fn();

  root.render(renderNode(commands, onClose));
  await sleep();

  return {
    root,
    onClose,
    output,
    rerender: async () => {
      root.render(renderNode(commands, onClose));
      await sleep();
    },
    dispose: () => {
      root.unmount();
      stdin.end();
      stdout.end();
    },
  };
}

describe("HelpV2 wave200 coverage", () => {
  beforeEach(() => {
    keybindingMock.groups = [];
    keybindingMock.singles = [];
    exitStateMock.state = {
      keyName: "ctrl+c",
      pending: true,
    };
  });

  it("keeps modal help cached across rerenders while showing no-query command labels and pending exit copy", async () => {
    const commands = [testCommand("help", "Show help")];
    const harness = await renderModalHelp(commands);

    try {
      await harness.rerender();
      expect(harness.output()).toContain("Press ctrl+c again to exit");

      invokeGroup("tabs:next");
      await harness.rerender();
      expect(harness.output()).toContain("Browse default commands:");
      expect(harness.output()).toContain("/help");

      invokeGroup("tabs:next");
      await harness.rerender();
      expect(harness.output()).toContain("No custom commands found");
    } finally {
      harness.dispose();
    }
  });
});
