import { PassThrough } from "node:stream";

import { getInkInstance } from "../../src/tui/ink/instances.js";
import { cellAt } from "../../src/tui/ink/screen.js";

export type PreviewHighlightStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

export type PreviewHighlightIo = {
  readonly stdin: PreviewHighlightStdin;
  readonly stdout: PassThrough;
};

const TTY_COLUMNS = 80;
const TTY_ROWS = 24;

/** Build a resumed TTY pair sized for PreviewSurface highlight assertions. */
export function createPreviewHighlightIo(): PreviewHighlightIo {
  const stdout = Object.assign(new PassThrough(), {
    columns: TTY_COLUMNS,
    rows: TTY_ROWS,
    isTTY: true,
  });
  stdout.resume();
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    ref() {},
    setRawMode() {},
    unref() {},
  }) as PreviewHighlightStdin;
  return { stdin, stdout };
}

/** Flatten the current Ink front frame into trimmed rows. */
export function readInkFrontFrame(stdout: PassThrough): string {
  const frame = getInkInstance(stdout as unknown as NodeJS.WriteStream)
    ?.frontFrame.screen;
  if (frame == null) return "";
  const rows = new Array<string>(frame.height);
  for (let row = 0; row < frame.height; row += 1) {
    const glyphs = new Array<string>(frame.width);
    for (let column = 0; column < frame.width; column += 1) {
      glyphs[column] = cellAt(frame, column, row)?.char ?? " ";
    }
    rows[row] = glyphs.join("").replace(/\s+$/u, "");
  }
  return rows.join("\n");
}

export function delayPaint(ms = 25): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, ms);
  });
}

export async function pollUntil<T>(
  pick: () => T | undefined,
  message: string,
  attempts = 40,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = pick();
    if (found !== undefined) return found;
    await delayPaint();
  }
  throw new Error(message);
}
