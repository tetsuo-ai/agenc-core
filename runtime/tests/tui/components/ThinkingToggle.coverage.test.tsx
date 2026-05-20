import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import { ThinkingToggle } from "./ThinkingToggle.js";

const harness = vi.hoisted(() => ({
  keybindings: {} as Record<
    string,
    {
      handler: () => void;
      options?: { isActive?: boolean };
    }
  >,
  selectProps: undefined as
    | undefined
    | {
        defaultFocusValue?: string;
        defaultValue?: string;
        onChange: (value: string) => void;
        options: Array<{ label: string; value: string }>;
        visibleOptionCount: number;
      },
}));

vi.mock("src/tui/hooks/useExitOnCtrlCDWithKeybindings.js", () => ({
  useExitOnCtrlCDWithKeybindings: () => ({
    keyName: "Ctrl+D",
    pending: false,
  }),
}));

vi.mock("../keybindings/useKeybinding.js", () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options?: { isActive?: boolean },
  ) => {
    harness.keybindings[action] = { handler, options };
  },
}));

vi.mock("./CustomSelect/select.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  const { Text } = await vi.importActual<typeof import("../ink.js")>(
    "../ink.js",
  );

  return {
    Select: (props: typeof harness.selectProps) => {
      harness.selectProps = props;
      return ReactActual.createElement(
        ReactActual.Fragment,
        null,
        props?.options.map(option =>
          ReactActual.createElement(
            Text,
            { key: option.value },
            `${option.label}:${option.value}`,
          ),
        ),
      );
    },
  };
});

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";

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
  (stdout as unknown as { columns: number; rows: number }).columns = 100;
  (stdout as unknown as { columns: number; rows: number }).rows = 24;

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

describe("ThinkingToggle", () => {
  beforeEach(() => {
    harness.keybindings = {};
    harness.selectProps = undefined;
  });

  test("requires confirmation before changing thinking mode mid-conversation", async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
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

    try {
      root.render(
        <ThinkingToggle
          currentValue={true}
          isMidConversation={true}
          onCancel={onCancel}
          onSelect={onSelect}
        />,
      );
      await sleep();

      expect(harness.selectProps).toMatchObject({
        defaultFocusValue: "true",
        defaultValue: "true",
        visibleOptionCount: 2,
      });
      expect(harness.selectProps?.options.map(option => option.value)).toEqual([
        "true",
        "false",
      ]);
      expect(stripAnsi(extractLastFrame(output))).toContain(
        "Enable or disable thinking for this session.",
      );

      harness.selectProps?.onChange("false");
      await sleep();

      const confirmationOutput = stripAnsi(extractLastFrame(output));
      expect(onSelect).not.toHaveBeenCalled();
      expect(confirmationOutput).toContain(
        "Changing thinking mode mid-conversation will increase latency",
      );
      expect(confirmationOutput).toContain("Do you want to proceed?");
      expect(confirmationOutput).toContain("Esc to cancel");
      expect(harness.keybindings["confirm:yes"]?.options?.isActive).toBe(true);

      harness.keybindings["confirm:yes"]?.handler();

      expect(onSelect).toHaveBeenCalledExactlyOnceWith(false);
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
