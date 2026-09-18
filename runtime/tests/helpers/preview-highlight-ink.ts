import { PassThrough } from "node:stream";
import { createElement, type ReactElement } from "react";

import { createRoot } from "../../src/tui/ink.js";
import { getInkInstance } from "../../src/tui/ink/instances.js";
import { cellAt } from "../../src/tui/ink/screen.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { PreviewSurface } from "../../src/tui/workbench/surfaces/PreviewSurface.js";

export type PreviewHighlightView = {
  readonly frame: () => string;
  readonly paint: () => Promise<void>;
};

const TTY_COLUMNS = 80;
const TTY_ROWS = 24;
const PAINT_MS = 25;

function attachTty(stream: PassThrough, extra: Record<string, unknown>): PassThrough {
  return Object.assign(stream, extra);
}

function createPreviewHighlightIo(): {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
} {
  const stdout = attachTty(new PassThrough(), {
    columns: TTY_COLUMNS,
    rows: TTY_ROWS,
    isTTY: true,
  });
  stdout.resume();
  return {
    stdout,
    stdin: attachTty(new PassThrough(), {
      isTTY: true,
      ref() {},
      setRawMode() {},
      unref() {},
    }),
  };
}

function readInkFrontFrame(stdout: PassThrough): string {
  const frame = getInkInstance(stdout as never)?.frontFrame.screen;
  if (!frame) return "";
  const rows: string[] = [];
  let row = 0;
  while (row < frame.height) {
    let line = "";
    let column = 0;
    while (column < frame.width) {
      line += cellAt(frame, column, row)?.char ?? " ";
      column += 1;
    }
    rows.push(line.replace(/\s+$/u, ""));
    row += 1;
  }
  return rows.join("\n");
}

function delayPaint(): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, PAINT_MS);
  });
}

function highlightPreviewTree(): ReactElement {
  const snapshot = getDefaultAppState();
  const workbench = Object.assign({}, snapshot.workbench, {
    activeSurfaceMode: "preview" as const,
    activeFilePath: "repeated.ts",
    activeFileLine: 1,
  });
  return createElement(
    AppStateProvider,
    { initialState: Object.assign({}, snapshot, { workbench }) },
    createElement(PreviewSurface, { focused: true }),
  );
}

export async function pollUntil<T>(
  pick: () => T | undefined,
  message: string,
  attempts = 40,
): Promise<T> {
  let attempt = 0;
  while (attempt < attempts) {
    const found = pick();
    if (found !== undefined) return found;
    await delayPaint();
    attempt += 1;
  }
  throw new Error(message);
}

export async function exercisePreviewHighlight(
  body: (view: PreviewHighlightView) => Promise<void>,
): Promise<void> {
  const io = createPreviewHighlightIo();
  const ink = await createRoot({
    patchConsole: false,
    stdin: io.stdin as never,
    stdout: io.stdout as never,
  });
  ink.render(highlightPreviewTree());
  try {
    await body({
      frame: () => readInkFrontFrame(io.stdout),
      paint: delayPaint,
    });
  } finally {
    ink.unmount();
    io.stdin.destroy();
    io.stdout.destroy();
  }
}
