import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../../../src/tui/ink.js";
import { ThinkingToggle } from "../../../src/tui/components/ThinkingToggle.js";

type KeybindingRecord = {
  handler: () => void;
  options?: {
    context?: string;
    isActive?: boolean;
  };
};

type SelectProps = {
  defaultFocusValue?: string;
  defaultValue?: string;
  onCancel?: () => void;
  onChange: (value: string) => void;
  options: Array<{
    description?: string;
    label: string;
    value: string;
  }>;
  visibleOptionCount: number;
};

const harness = vi.hoisted(() => ({
  exitState: {
    keyName: "Ctrl+D",
    pending: false,
  },
  keybindings: {} as Record<string, KeybindingRecord>,
  selectProps: undefined as SelectProps | undefined,
}));

vi.mock("src/tui/hooks/useExitOnCtrlCDWithKeybindings.js", () => ({
  useExitOnCtrlCDWithKeybindings: () => harness.exitState,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options?: KeybindingRecord["options"],
  ) => {
    harness.keybindings[action] = { handler, options };
  },
}));

vi.mock("../../../src/tui/components/CustomSelect/select.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  const { default: Text } = await vi.importActual<
    typeof import("../../../src/tui/ink/components/Text.js")
  >("../../../src/tui/ink/components/Text.js");

  return {
    Select: (props: SelectProps) => {
      harness.selectProps = props;

      return ReactActual.createElement(
        ReactActual.Fragment,
        null,
        props.options.map(option =>
          ReactActual.createElement(
            Text,
            { key: option.value },
            `${option.label}:${option.value}:${option.description ?? ""}`,
          ),
        ),
      );
    },
  };
});

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";

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

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null;
  let cursor = 0;

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor);
    if (start === -1) break;

    const contentStart = start + SYNC_START.length;
    const end = output.indexOf(SYNC_END, contentStart);
    if (end === -1) break;

    const frame = output.slice(contentStart, end);
    if (frame.trim().length > 0) {
      lastFrame = frame;
    }
    cursor = end + SYNC_END.length;
  }

  return lastFrame ?? output;
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function compactText(text: string): string {
  return text.replace(/\s+/g, "");
}

async function renderToggle(props: {
  currentValue: boolean;
  isMidConversation?: boolean;
  onCancel?: () => void;
  onSelect: (enabled: boolean) => void;
}): Promise<{
  readonly getText: () => string;
  readonly stdin: TestStdin;
  readonly stdout: TestStdout;
  readonly unmount: () => Promise<void>;
}> {
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

  root.render(<ThinkingToggle {...props} />);
  await sleep();

  return {
    getText: () => stripAnsi(extractLastFrame(output)),
    stdin,
    stdout,
    unmount: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    },
  };
}

describe("ThinkingToggle coverage swarm row 073", () => {
  beforeEach(() => {
    harness.exitState = {
      keyName: "Ctrl+D",
      pending: false,
    };
    harness.keybindings = {};
    harness.selectProps = undefined;
  });

  test("selects immediately outside a mid-conversation change", async () => {
    const onSelect = vi.fn();
    const rendered = await renderToggle({
      currentValue: false,
      onSelect,
    });

    try {
      expect(harness.selectProps).toMatchObject({
        defaultFocusValue: "false",
        defaultValue: "false",
        visibleOptionCount: 2,
      });
      expect(harness.selectProps?.options).toEqual([
        {
          description: "AgenC will think before responding",
          label: "Enabled",
          value: "true",
        },
        {
          description: "AgenC will respond without extended thinking",
          label: "Disabled",
          value: "false",
        },
      ]);

      const text = compactText(rendered.getText());
      expect(text).toContain("Enableordisablethinkingforthissession.");
      expect(text).toContain("Esctoexit");
      expect(harness.keybindings["confirm:yes"]?.options).toEqual({
        context: "Confirmation",
        isActive: false,
      });

      harness.selectProps?.onChange("true");
      harness.keybindings["confirm:yes"]?.handler();
      harness.selectProps?.onCancel?.();

      expect(onSelect).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      await rendered.unmount();
    }
  });

  test("uses no to clear pending confirmation before canceling", async () => {
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    const rendered = await renderToggle({
      currentValue: false,
      isMidConversation: true,
      onCancel,
      onSelect,
    });

    try {
      harness.selectProps?.onChange("true");
      await sleep();

      expect(onSelect).not.toHaveBeenCalled();
      expect(rendered.getText()).toContain("Do you want to proceed?");
      expect(compactText(rendered.getText())).toContain("Esctocancel");
      expect(harness.keybindings["confirm:yes"]?.options?.isActive).toBe(true);

      harness.keybindings["confirm:no"]?.handler();
      await sleep();

      expect(onCancel).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
      expect(harness.selectProps?.defaultValue).toBe("false");

      harness.keybindings["confirm:yes"]?.handler();
      harness.keybindings["confirm:no"]?.handler();

      expect(onSelect).not.toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalledOnce();
    } finally {
      await rendered.unmount();
    }
  });

  test("shows exit-pending footer and accepts unchanged mid-conversation value", async () => {
    harness.exitState = {
      keyName: "Ctrl+C",
      pending: true,
    };
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    const rendered = await renderToggle({
      currentValue: true,
      isMidConversation: true,
      onCancel,
      onSelect,
    });

    try {
      expect(compactText(rendered.getText())).toContain(
        "PressCtrl+Cagaintoexit",
      );
      expect(compactText(rendered.getText())).not.toContain("Esctoexit");

      harness.selectProps?.onChange("true");

      expect(onSelect).toHaveBeenCalledExactlyOnceWith(true);
      expect(onCancel).not.toHaveBeenCalled();
      expect(compactText(rendered.getText())).not.toContain(
        "Doyouwanttoproceed?",
      );
    } finally {
      await rendered.unmount();
    }
  });
});
