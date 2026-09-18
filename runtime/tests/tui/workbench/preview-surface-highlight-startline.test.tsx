import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRoot } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { PreviewSurface } from "../../../src/tui/workbench/surfaces/PreviewSurface.js";
import {
  createPreviewHighlightIo,
  delayPaint,
  pollUntil,
  readInkFrontFrame,
} from "../../helpers/preview-highlight-ink.js";

const IDENTICAL_PAGE = "const value = 1;\nconst other = 2;";
const FIRST_OFFSET = 0;
const SECOND_OFFSET = 80;
const PAGE_STEP = 20;
const TOTAL_LINES = 200;

type VisibleLine = {
  readonly number: number;
  readonly text: string;
};

type HighlightCall = {
  readonly path: string | null;
  readonly lines: readonly VisibleLine[];
  readonly resolve: (map: ReadonlyMap<number, string>) => void;
};

const previewHarness = vi.hoisted(() => ({
  handlers: {} as Record<string, () => void>,
  highlightCalls: [] as HighlightCall[],
}));

vi.mock("../../../src/utils/readFileInRange.js", () => ({
  readFileInRange: vi.fn(async () => ({
    content: IDENTICAL_PAGE,
    lineCount: 2,
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
    const deferred = Promise.withResolvers<ReadonlyMap<number, string>>();
    previewHarness.highlightCalls.push({
      path: filePath,
      lines: lines.map(({ number, text }) => ({ number, text })),
      resolve: deferred.resolve,
    });
    return deferred.promise;
  }),
}));

function previewAppState() {
  const base = getDefaultAppState();
  return {
    ...base,
    workbench: {
      ...base.workbench,
      activeSurfaceMode: "preview" as const,
      activeFilePath: "repeated.ts",
      activeFileLine: 1,
    },
  };
}

function markWindow(
  lines: readonly VisibleLine[],
  tag: string,
): ReadonlyMap<number, string> {
  return new Map(lines.map(({ number }) => [number, `${tag}:${number}`]));
}

function windowAt(offset: number): Promise<HighlightCall> {
  const startNumber = offset + 1;
  return pollUntil(
    () => previewHarness.highlightCalls.find(
      (call) => call.lines[0]?.number === startNumber,
    ),
    `highlight window at offset ${offset} did not start`,
  );
}

async function withMountedPreview(
  run: (stdout: ReturnType<typeof createPreviewHighlightIo>["stdout"]) => Promise<void>,
): Promise<void> {
  const { stdin, stdout } = createPreviewHighlightIo();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  root.render(
    <AppStateProvider initialState={previewAppState()}>
      <PreviewSurface focused={true} />
    </AppStateProvider>,
  );
  try {
    await run(stdout);
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
  }
}

function pageToOffset(offset: number): void {
  const steps = offset / PAGE_STEP;
  for (let step = 0; step < steps; step += 1) {
    previewHarness.handlers["surface:pageDown"]?.();
  }
}

describe("PreviewSurface highlight startLine", () => {
  beforeEach(() => {
    previewHarness.handlers = {};
    previewHarness.highlightCalls = [];
  });

  it("rebuilds the highlight map when the same text is shown at offset 80", async () => {
    await withMountedPreview(async (stdout) => {
      const origin = await windowAt(FIRST_OFFSET);
      expect(origin.lines.map((line) => line.number)).toEqual([1, 2]);
      origin.resolve(markWindow(origin.lines, "WIN-A"));
      await delayPaint();
      expect(readInkFrontFrame(stdout)).toContain("WIN-A:1");

      pageToOffset(SECOND_OFFSET);
      const shifted = await windowAt(SECOND_OFFSET);
      expect(shifted.lines.map((line) => line.number)).toEqual([81, 82]);
      shifted.resolve(markWindow(shifted.lines, "WIN-B"));
      await delayPaint();

      const frame = readInkFrontFrame(stdout);
      expect(frame).toContain("WIN-B:81");
      expect(frame).not.toContain("WIN-A:1");
    });
  });

  it("ignores a late poison-pill map from the cancelled offset-0 request", async () => {
    await withMountedPreview(async (stdout) => {
      const origin = await windowAt(FIRST_OFFSET);
      pageToOffset(SECOND_OFFSET);
      const shifted = await windowAt(SECOND_OFFSET);

      origin.resolve(new Map([
        [1, "STALE:1"],
        [81, "STALE:81"],
      ]));
      await delayPaint();
      expect(readInkFrontFrame(stdout)).not.toContain("STALE:81");

      shifted.resolve(markWindow(shifted.lines, "FRESH"));
      await delayPaint();
      const frame = readInkFrontFrame(stdout);
      expect(frame).toContain("FRESH:81");
      expect(frame).not.toContain("STALE:81");
    });
  });
});
