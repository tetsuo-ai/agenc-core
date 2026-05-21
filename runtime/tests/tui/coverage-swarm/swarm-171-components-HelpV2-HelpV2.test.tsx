import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Command } from "../../../src/commands.js";

type KeybindingRecord = {
  action: string;
  handler: () => void;
  options: {
    context?: string;
    isActive?: boolean;
  };
};

type CommandPanelRecord = {
  columns: number;
  emptyMessage?: string;
  maxHeight: number;
  names: string[];
  title: string;
};

const harness = vi.hoisted(() => ({
  commandPanels: [] as CommandPanelRecord[],
  exitHandler: undefined as (() => void) | undefined,
  exitState: {
    keyName: "ctrl+c",
    pending: false,
  },
  insideModal: false,
  keybindings: [] as KeybindingRecord[],
  modalSize: undefined as { columns: number; rows: number } | undefined,
  panes: [] as Array<{ color?: string }>,
  shortcut: "esc",
  tabs: [] as Array<{
    color?: string;
    defaultTab?: string;
    title?: string;
  }>,
  terminalSize: {
    columns: 100,
    rows: 24,
  },
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("src/tui/hooks/useExitOnCtrlCDWithKeybindings.js", () => ({
  useExitOnCtrlCDWithKeybindings: (handler: () => void) => {
    harness.exitHandler = handler;
    return harness.exitState;
  },
}));

vi.mock("../../../src/commands.js", () => ({
  builtInCommandNames: () => new Set(["help", "status"]),
}));

vi.mock("../../../src/tui/context/modalContext.js", () => ({
  useIsInsideModal: () => harness.insideModal,
  useModalOrTerminalSize: (fallback: { columns: number; rows: number }) =>
    harness.modalSize ?? fallback,
}));

vi.mock("../../../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => harness.terminalSize,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options: KeybindingRecord["options"] = {},
  ) => {
    harness.keybindings.push({ action, handler, options });
  },
}));

vi.mock("../../../src/tui/keybindings/useShortcutDisplay.js", () => ({
  useShortcutDisplay: () => harness.shortcut,
}));

vi.mock("../../../src/tui/components/design-system/Pane.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  const { default: Box } = await vi.importActual<
    typeof import("../../../src/tui/ink/components/Box.js")
  >("../../../src/tui/ink/components/Box.js");

  return {
    Pane: (props: { children?: React.ReactNode; color?: string }) => {
      harness.panes.push({ color: props.color });
      return ReactActual.createElement(
        Box,
        { flexDirection: "column" },
        props.children,
      );
    },
  };
});

vi.mock("../../../src/tui/components/design-system/Tabs.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  const { default: Box } = await vi.importActual<
    typeof import("../../../src/tui/ink/components/Box.js")
  >("../../../src/tui/ink/components/Box.js");
  const { default: Text } = await vi.importActual<
    typeof import("../../../src/tui/ink/components/Text.js")
  >("../../../src/tui/ink/components/Text.js");

  return {
    Tab: (props: { children?: React.ReactNode; title: string }) =>
      ReactActual.createElement(
        Box,
        { flexDirection: "column" },
        ReactActual.createElement(Text, null, `tab:${props.title}`),
        props.children,
      ),
    Tabs: (props: {
      children?: React.ReactNode;
      color?: string;
      defaultTab?: string;
      title?: string;
    }) => {
      harness.tabs.push({
        color: props.color,
        defaultTab: props.defaultTab,
        title: props.title,
      });

      return ReactActual.createElement(
        Box,
        { flexDirection: "column" },
        ReactActual.createElement(
          Text,
          null,
          `tabs:${props.title}:${props.color}:${props.defaultTab}`,
        ),
        props.children,
      );
    },
  };
});

vi.mock("../../../src/tui/components/HelpV2/Commands.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  const { default: Text } = await vi.importActual<
    typeof import("../../../src/tui/ink/components/Text.js")
  >("../../../src/tui/ink/components/Text.js");

  return {
    Commands: (props: {
      columns: number;
      commands: Array<{ name: string }>;
      emptyMessage?: string;
      maxHeight: number;
      title: string;
    }) => {
      const names = props.commands.map(command => command.name);
      harness.commandPanels.push({
        columns: props.columns,
        emptyMessage: props.emptyMessage,
        maxHeight: props.maxHeight,
        names,
        title: props.title,
      });

      return ReactActual.createElement(
        Text,
        null,
        `commands:${props.title}:${names.join(",")}:${
          props.emptyMessage ?? ""
        }`,
      );
    },
  };
});

vi.mock("../../../src/tui/components/HelpV2/General.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  const { default: Text } = await vi.importActual<
    typeof import("../../../src/tui/ink/components/Text.js")
  >("../../../src/tui/ink/components/Text.js");

  return {
    General: () => ReactActual.createElement(Text, null, "general-help"),
  };
});

import { HelpV2 } from "../../../src/tui/components/HelpV2/HelpV2.js";
import { createRoot, type Root } from "../../../src/tui/ink.js";

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

function makeCommand(
  name: string,
  overrides: Partial<Command> = {},
): Command {
  return {
    contentLength: name.length,
    description: `${name} description`,
    name,
    progressMessage: "running",
    type: "prompt",
    ...overrides,
  } as Command;
}

function createStreams(): {
  output: () => string;
  stdin: TestStdin;
  stdout: TestStdout;
} {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough() as TestStdout;
  let rendered = "";

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};

  stdout.columns = 120;
  stdout.rows = 30;
  stdout.isTTY = true;
  stdout.on("data", chunk => {
    rendered += chunk.toString();
  });
  stdout.resume();

  return {
    output: () => stripAnsi(rendered),
    stdin,
    stdout,
  };
}

function sleep(ms = 30): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function compactText(text: string): string {
  return text.replace(/\s+/g, "");
}

async function renderHelp(props: {
  commands: Command[];
  onClose: (result?: string, options?: { display?: string }) => void;
  query?: string;
}): Promise<{
  output: () => string;
  render: (nextProps: typeof props) => Promise<void>;
  root: Root;
  unmount: () => void;
}> {
  const { output, stdin, stdout } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  const render = async (nextProps: typeof props): Promise<void> => {
    root.render(<HelpV2 {...nextProps} />);
    await sleep();
  };

  await render(props);

  return {
    output,
    render,
    root,
    unmount: () => {
      root.unmount();
      stdin.end();
      stdout.end();
    },
  };
}

function latestPanel(title: string): CommandPanelRecord {
  const panel = [...harness.commandPanels]
    .reverse()
    .find(candidate => candidate.title === title);

  if (!panel) {
    throw new Error(`No command panel found for ${title}`);
  }

  return panel;
}

describe("HelpV2 coverage swarm row 171", () => {
  beforeEach(() => {
    harness.commandPanels = [];
    harness.exitHandler = undefined;
    harness.exitState = {
      keyName: "ctrl+c",
      pending: false,
    };
    harness.insideModal = false;
    harness.keybindings = [];
    harness.modalSize = undefined;
    harness.panes = [];
    harness.shortcut = "esc";
    harness.tabs = [];
    harness.terminalSize = {
      columns: 100,
      rows: 24,
    };
  });

  test("filters commands, registers dismissal, and refreshes cached footer state", async () => {
    const onClose = vi.fn();
    const commands = [
      makeCommand("help"),
      makeCommand("status", { isHidden: true }),
      makeCommand("deploy-project", { source: "plugin" }),
      makeCommand("secret-project", { isHidden: true, source: "plugin" }),
    ];
    const props = { commands, onClose, query: "deploy" };
    const rendered = await renderHelp(props);

    try {
      expect(harness.tabs.at(-1)).toEqual({
        color: "professionalBlue",
        defaultTab: "general",
        title: "AgenC Help",
      });
      expect(harness.panes.at(-1)).toEqual({ color: "professionalBlue" });
      expect(harness.keybindings.at(-1)).toMatchObject({
        action: "help:dismiss",
        options: { context: "Help" },
      });

      expect(latestPanel("Default commands matching deploy:")).toMatchObject({
        columns: 100,
        names: ["help"],
      });
      expect(latestPanel("Custom commands matching deploy:")).toMatchObject({
        columns: 100,
        emptyMessage: "No matching custom commands",
        names: ["deploy-project"],
      });
      expect(compactText(rendered.output())).toContain("esctocancel");

      harness.keybindings.at(-1)?.handler();
      expect(onClose).toHaveBeenCalledWith("Help dialog dismissed", {
        display: "system",
      });

      harness.exitHandler?.();
      expect(onClose).toHaveBeenCalledTimes(2);

      await rendered.render(props);
      harness.exitState = {
        keyName: "ctrl+d",
        pending: true,
      };
      await rendered.render(props);

      expect(compactText(rendered.output())).toContain("Pressctrl+dagaintoexit");
    } finally {
      rendered.unmount();
    }
  });

  test("uses modal dimensions and no-query labels when rendered inside a modal", async () => {
    const onClose = vi.fn();
    const initialCommands = [makeCommand("help")];
    const rendered = await renderHelp({
      commands: initialCommands,
      onClose,
      query: "initial",
    });

    try {
      harness.insideModal = true;
      harness.modalSize = {
        columns: 42,
        rows: 10,
      };

      await rendered.render({
        commands: [makeCommand("help")],
        onClose,
      });

      expect(latestPanel("Browse default commands:")).toMatchObject({
        columns: 42,
        maxHeight: 5,
        names: ["help"],
      });
      expect(latestPanel("Browse custom commands:")).toMatchObject({
        columns: 42,
        emptyMessage: "No custom commands found",
        maxHeight: 5,
        names: [],
      });
    } finally {
      rendered.unmount();
    }
  });
});
