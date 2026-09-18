import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRoot } from "../../../src/tui/ink.js";
import { getInkInstance } from "../../../src/tui/ink/instances.js";
import { cellAt } from "../../../src/tui/ink/screen.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { PreviewSurface } from "../../../src/tui/workbench/surfaces/PreviewSurface.js";

const IDENTICAL_PAGE = "const value = 1;\nconst other = 2;";
const PAGE_START_DELTA = 80;
const SECOND_START_LINE = PAGE_START_DELTA;
const TOTAL_LINES = 200;

type VisibleLine = {
  readonly number: number;
  readonly text: string;
};

type HighlightCall = {
  readonly path: string | null;
  readonly lines: readonly VisibleLine[];
  readonly resolve: (map: ReadonlyMap<number, string>) => void;
  readonly reject: (error: unknown) => void;
};

const previewHarness = vi.hoisted(() => ({
  handlers: {} as Record<string, () => void>,
  highlightCalls: [] as HighlightCall[],
}));

vi.mock("../../../src/utils/readFileInRange.js", () => ({
  readFileInRange: vi.fn(async () => ({
    content: IDENTICAL_PAGE,
    lineCount: IDENTICAL_PAGE.split("\n").length,
    totalLines: TOTAL_LINES,
    totalBytes: Buffer.byteLength(IDENTICAL_PAGE),
    readBytes: Buffer.byteLength(IDENTICAL_PAGE),
    mtimeMs: 1,
  })),
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useInputCapture: () => {},
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => void>) => {
    previewHarness.handlers = handlers;
  },
}));

vi.mock("../../../src/tui/workbench/project-tree/gitStatus.js", () => ({
  collectGitStatus: vi.fn(async () => new Map()),
}));

vi.mock("../../../src/tui/workbench/buffer/highlight.js", () => ({
  highlightBufferVisibleLines: vi.fn((
    filePath: string | null,
    lines: readonly VisibleLine[],
  ) => {
    let resolve!: (map: ReadonlyMap<number, string>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ReadonlyMap<number, string>>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    previewHarness.highlightCalls.push({
      path: filePath,
      lines: lines.map((line) => ({ number: line.number, text: line.text })),
      resolve,
      reject,
    });
    return promise;
  }),
}));

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 80;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 24;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true;
  stdout.resume();

  return { stdin, stdout };
}

function sleep(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHighlightWindow(startNumber: number): Promise<HighlightCall> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const call = previewHarness.highlightCalls.find(
      (entry) => entry.lines[0]?.number === startNumber,
    );
    if (call) return call;
    await sleep();
  }
  throw new Error(`Preview highlight for line ${startNumber} did not start`);
}

function currentScreenText(stdout: PassThrough): string {
  const screen = getInkInstance(stdout as unknown as NodeJS.WriteStream)
    ?.frontFrame.screen;
  if (!screen) return "";
  return Array.from({ length: screen.height }, (_, row) =>
    Array.from(
      { length: screen.width },
      (_, column) => cellAt(screen, column, row)?.char ?? " ",
    )
      .join("")
      .trimEnd(),
  ).join("\n");
}

function highlightMap(
  lines: readonly VisibleLine[],
  prefix: string,
): ReadonlyMap<number, string> {
  return new Map(lines.map((line) => [line.number, `${prefix}:${line.number}`]));
}

function lineNumbers(call: HighlightCall): readonly number[] {
  return call.lines.map((line) => line.number);
}

async function renderPreview(): Promise<{
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
  readonly unmount: () => void;
}> {
  const { stdin, stdout } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  root.render(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        workbench: {
          ...getDefaultAppState().workbench,
          activeSurfaceMode: "preview",
          activeFilePath: "repeated.ts",
          activeFileLine: 1,
        },
      }}
    >
      <PreviewSurface focused={true} />
    </AppStateProvider>,
  );
  return {
    stdin,
    stdout,
    unmount() {
      root.unmount();
      stdin.end();
      stdout.end();
    },
  };
}

function movePreviewToSecondWindow(): void {
  const pageDowns = PAGE_START_DELTA / 20;
  for (let index = 0; index < pageDowns; index += 1) {
    previewHarness.handlers["surface:pageDown"]?.();
  }
}

describe("PreviewSurface highlight startLine", () => {
  beforeEach(() => {
    previewHarness.handlers = {};
    previewHarness.highlightCalls = [];
  });

  it("recomputes a highlight map when identical text appears at a new startLine", async () => {
    const { stdout, unmount } = await renderPreview();

    try {
      const first = await waitForHighlightWindow(1);
      expect(lineNumbers(first)).toEqual([1, 2]);
      first.resolve(highlightMap(first.lines, "WIN-A"));
      await sleep();

      expect(currentScreenText(stdout)).toContain("WIN-A:1");

      movePreviewToSecondWindow();

      const second = await waitForHighlightWindow(SECOND_START_LINE + 1);
      expect(lineNumbers(second)).toEqual([
        SECOND_START_LINE + 1,
        SECOND_START_LINE + 2,
      ]);
      second.resolve(highlightMap(second.lines, "WIN-B"));
      await sleep();

      const screen = currentScreenText(stdout);
      expect(screen).toContain("WIN-B:81");
      expect(screen).not.toContain("WIN-A:1");
    } finally {
      unmount();
    }
  });

  it("does not let a late highlight for the old window replace the new map", async () => {
    const { stdout, unmount } = await renderPreview();

    try {
      const first = await waitForHighlightWindow(1);
      expect(lineNumbers(first)).toEqual([1, 2]);

      movePreviewToSecondWindow();

      const second = await waitForHighlightWindow(SECOND_START_LINE + 1);
      expect(lineNumbers(second)).toEqual([
        SECOND_START_LINE + 1,
        SECOND_START_LINE + 2,
      ]);

      first.resolve(new Map([
        [1, "STALE:1"],
        [SECOND_START_LINE + 1, "STALE:81"],
      ]));
      await sleep();

      expect(currentScreenText(stdout)).not.toContain("STALE:81");

      second.resolve(highlightMap(second.lines, "FRESH"));
      await sleep();

      const screen = currentScreenText(stdout);
      expect(screen).toContain("FRESH:81");
      expect(screen).not.toContain("STALE:81");
    } finally {
      unmount();
    }
  });
});
