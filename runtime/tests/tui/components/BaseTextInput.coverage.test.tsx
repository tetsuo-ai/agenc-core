import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test, vi } from "vitest";

import type { BaseInputState } from "../../types/textInputTypes.js";
import type { TextHighlight } from "../../utils/textHighlighting.js";
import { createRoot, Text } from "../ink.js";
import { BaseTextInput } from "./BaseTextInput.js";

const highlightedInputMock = vi.hoisted(() => ({
  calls: [] as Array<{
    text: string;
    highlights: TextHighlight[];
  }>,
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

vi.mock("./PromptInput/ShimmeredInput.js", async () => {
  const ReactModule = await import("react");
  const { Text: InkText } = await import("../ink.js");

  return {
    HighlightedInput: ({
      text,
      highlights,
    }: {
      text: string;
      highlights: TextHighlight[];
    }) => {
      highlightedInputMock.calls.push({ text, highlights });
      return ReactModule.createElement(InkText, null, `highlighted:${text}`);
    },
  };
});

function createInputState(
  overrides: Partial<BaseInputState> = {},
): BaseInputState {
  return {
    cursorColumn: 4,
    cursorLine: 0,
    offset: 4,
    onInput: vi.fn(),
    renderedValue: "eview",
    setOffset: vi.fn(),
    setValue: vi.fn(),
    value: "/review",
    viewportCharEnd: 7,
    viewportCharOffset: 2,
    ...overrides,
  };
}

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

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe("BaseTextInput coverage", () => {
  test("clips visible highlights and preserves command argument hints in the highlighted render path", async () => {
    highlightedInputMock.calls = [];
    const onIsPastingChange = vi.fn();
    const inputState = createInputState();
    const highlights: TextHighlight[] = [
      { color: "success", end: 3, priority: 1, start: 1 },
      { color: "error", end: 5, priority: 3, start: 3 },
      { color: "warning", dimColor: true, end: 7, priority: 2, start: 4 },
      { color: "suggestion", end: 9, priority: 1, start: 7 },
    ];
    const { getOutput, stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    root.render(
      <BaseTextInput
        argumentHint="<target>"
        columns={80}
        cursorOffset={inputState.offset}
        focus={true}
        highlights={highlights}
        inputState={inputState}
        onChange={vi.fn()}
        onChangeCursorOffset={vi.fn()}
        onIsPastingChange={onIsPastingChange}
        showCursor={true}
        terminalFocus={true}
        value={inputState.value}
      >
        <Text> child</Text>
      </BaseTextInput>,
    );
    await sleep();

    const output = stripAnsi(extractLastFrame(getOutput()));

    try {
      expect(output).toContain("highlighted:eview <target> child");
      expect(onIsPastingChange).toHaveBeenCalledWith(false);
      expect(highlightedInputMock.calls).toEqual([
        {
          text: "eview",
          highlights: [
            { color: "success", end: 1, priority: 1, start: 0 },
            { color: "warning", dimColor: true, end: 5, priority: 2, start: 2 },
          ],
        },
      ]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
