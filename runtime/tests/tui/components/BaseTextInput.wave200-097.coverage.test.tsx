import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test, vi } from "vitest";

import type { BaseInputState } from "../../types/textInputTypes.js";
import { createRoot, Text } from "../ink.js";
import type { Key } from "../ink.js";
import { BaseTextInput } from "./BaseTextInput.js";

const pasteHarness = vi.hoisted(() => ({
  isPasting: false,
  onInput: undefined as
    | undefined
    | ((input: string, key: { return?: boolean }) => void),
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../../utils/config.js", () => ({
  getGlobalConfig: () => ({ theme: "dark" }),
  saveGlobalConfig: vi.fn(),
}));

vi.mock("../../utils/systemTheme.js", () => ({
  getSystemThemeName: () => "dark",
  resolveThemeSetting: () => "dark",
}));

vi.mock("../hooks/usePasteHandler.js", () => ({
  usePasteHandler: ({
    onInput,
  }: {
    onInput: (input: string, key: { return?: boolean }) => void;
  }) => {
    pasteHarness.onInput = onInput;
    return {
      isPasting: pasteHarness.isPasting,
      wrappedOnInput: vi.fn(),
    };
  },
}));

vi.mock("./PromptInput/ShimmeredInput.js", async () => {
  const ReactModule = await import("react");
  const { Text: InkText } = await import("../ink.js");

  return {
    HighlightedInput: ({ text }: { text: string }) =>
      ReactModule.createElement(InkText, null, text),
  };
});

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null;
  let cursor = 0;

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor);
    if (start === -1) {
      break;
    }

    const contentStart = start + SYNC_START.length;
    const end = output.indexOf(SYNC_END, contentStart);
    if (end === -1) {
      break;
    }

    const frame = output.slice(contentStart, end);
    if (frame.trim().length > 0) {
      lastFrame = frame;
    }
    cursor = end + SYNC_END.length;
  }

  return lastFrame ?? output;
}

function createStreams(): {
  stdout: PassThrough;
  stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  getOutput: () => string;
} {
  let output = "";
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
  (stdout as unknown as { columns: number }).columns = 80;
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  return { getOutput: () => output, stdin, stdout };
}

function createInputState(
  overrides: Partial<BaseInputState> = {},
): BaseInputState {
  return {
    cursorColumn: 0,
    cursorLine: 0,
    offset: 0,
    onInput: vi.fn(),
    renderedValue: "",
    setOffset: vi.fn(),
    setValue: vi.fn(),
    value: "",
    viewportCharEnd: 0,
    viewportCharOffset: 0,
    ...overrides,
  };
}

function returnKey(): Key {
  return { return: true } as Key;
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe("BaseTextInput wave200 coverage", () => {
  test("renders the plain input path and suppresses return while paste is active", async () => {
    pasteHarness.isPasting = true;
    pasteHarness.onInput = undefined;
    const onInput = vi.fn();
    const onIsPastingChange = vi.fn();
    const inputState = createInputState({ onInput });
    const { getOutput, stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <BaseTextInput
          columns={80}
          cursorOffset={0}
          focus={true}
          inputState={inputState}
          onChange={vi.fn()}
          onChangeCursorOffset={vi.fn()}
          onIsPastingChange={onIsPastingChange}
          placeholder="fallback placeholder"
          placeholderElement={<Text>custom placeholder</Text>}
          showCursor={true}
          terminalFocus={true}
          value=""
        >
          <Text> tail</Text>
        </BaseTextInput>,
      );
      await sleep();

      const placeholderFrame = stripAnsi(extractLastFrame(getOutput()));
      expect(placeholderFrame).toContain("custom placeholder tail");
      expect(placeholderFrame).not.toContain("fallback placeholder");
      expect(onIsPastingChange).toHaveBeenCalledWith(true);

      expect(pasteHarness.onInput).toBeDefined();
      pasteHarness.onInput?.("ignored", returnKey());
      expect(onInput).not.toHaveBeenCalled();

      pasteHarness.onInput?.("typed", {} as Key);
      expect(onInput).toHaveBeenCalledWith("typed", {});

      pasteHarness.isPasting = false;
      const commandState = createInputState({
        cursorColumn: 6,
        offset: 6,
        onInput,
        renderedValue: "/ship ",
        value: "/ship ",
        viewportCharEnd: 6,
      });
      root.render(
        <BaseTextInput
          argumentHint="<path>"
          columns={80}
          cursorOffset={6}
          focus={true}
          inputState={commandState}
          onChange={vi.fn()}
          onChangeCursorOffset={vi.fn()}
          onIsPastingChange={onIsPastingChange}
          placeholder="fallback placeholder"
          showCursor={true}
          terminalFocus={true}
          value="/ship "
        >
          <Text> tail</Text>
        </BaseTextInput>,
      );
      await sleep();

      const commandFrame = stripAnsi(extractLastFrame(getOutput()));
      expect(commandFrame).toContain("/ship <path> tail");
      expect(commandFrame).not.toContain("/ship  <path>");
      expect(onIsPastingChange).toHaveBeenCalledWith(false);

      pasteHarness.onInput?.("submitted", returnKey());
      expect(onInput).toHaveBeenLastCalledWith("submitted", returnKey());
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
