import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  exercisePreviewHighlight,
  pollUntil,
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
  readonly lines: readonly VisibleLine[];
  readonly resolve: (map: ReadonlyMap<number, string>) => void;
};

const previewHarness = vi.hoisted(() => ({
  handlers: Object.create(null) as Record<string, () => void>,
  highlightCalls: [] as HighlightCall[],
}));

vi.mock("../../../src/utils/readFileInRange.js", () => ({
  readFileInRange: () => Promise.resolve({
    content: IDENTICAL_PAGE,
    lineCount: IDENTICAL_PAGE.split("\n").length,
    totalLines: TOTAL_LINES,
    totalBytes: IDENTICAL_PAGE.length,
    readBytes: IDENTICAL_PAGE.length,
    mtimeMs: 1,
  }),
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => {
  const ignore = () => undefined;
  return {
    useInputCapture: ignore,
    useKeybinding: ignore,
    useKeybindings(next: Record<string, () => void>) {
      previewHarness.handlers = next;
    },
  };
});

vi.mock("../../../src/tui/workbench/project-tree/gitStatus.js", () => ({
  collectGitStatus: () => Promise.resolve(new Map<string, never>()),
}));

vi.mock("../../../src/tui/workbench/buffer/highlight.js", () => ({
  highlightBufferVisibleLines(
    _filePath: string | null,
    lines: readonly VisibleLine[],
  ) {
    const deferred = Promise.withResolvers<ReadonlyMap<number, string>>();
    previewHarness.highlightCalls.push({
      lines: lines.map(({ number, text }) => ({ number, text })),
      resolve: deferred.resolve,
    });
    return deferred.promise;
  },
}));

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

function pageToOffset(offset: number): void {
  let remaining = offset;
  while (remaining > 0) {
    previewHarness.handlers["surface:pageDown"]?.();
    remaining -= PAGE_STEP;
  }
}

function expectLineNumbers(call: HighlightCall, offset: number): void {
  expect(call.lines.map((line) => line.number)).toEqual([
    offset + 1,
    offset + 2,
  ]);
}

describe("PreviewSurface highlight startLine", () => {
  beforeEach(() => {
    previewHarness.handlers = Object.create(null);
    previewHarness.highlightCalls.length = 0;
  });

  it("rebuilds the highlight map when the same text is shown at offset 80", async () => {
    await exercisePreviewHighlight(async ({ frame, paint }) => {
      const origin = await windowAt(FIRST_OFFSET);
      expectLineNumbers(origin, FIRST_OFFSET);
      origin.resolve(markWindow(origin.lines, "WIN-A"));
      await paint();
      expect(frame()).toContain("WIN-A:1");

      pageToOffset(SECOND_OFFSET);
      const shifted = await windowAt(SECOND_OFFSET);
      expectLineNumbers(shifted, SECOND_OFFSET);
      shifted.resolve(markWindow(shifted.lines, "WIN-B"));
      await paint();

      expect(frame()).toContain("WIN-B:81");
      expect(frame()).not.toContain("WIN-A:1");
    });
  });

  it("ignores a late poison-pill map from the cancelled offset-0 request", async () => {
    await exercisePreviewHighlight(async ({ frame, paint }) => {
      const origin = await windowAt(FIRST_OFFSET);
      pageToOffset(SECOND_OFFSET);
      const shifted = await windowAt(SECOND_OFFSET);

      origin.resolve(new Map([
        [1, "STALE:1"],
        [81, "STALE:81"],
      ]));
      await paint();
      expect(frame()).not.toContain("STALE:81");

      shifted.resolve(markWindow(shifted.lines, "FRESH"));
      await paint();
      expect(frame()).toContain("FRESH:81");
      expect(frame()).not.toContain("STALE:81");
    });
  });
});
