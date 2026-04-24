import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import Box from "../ink/components/Box.js";
import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import { cellAt, charInCellAt } from "../ink/screen.js";
import { ComposerBuffer } from "./ComposerBuffer.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(columns: number): {
  stdout: PassThrough;
  stdin: TestStdin;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = columns;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(
  element: React.ReactElement,
  columns = 32,
): Promise<{
  stdout: PassThrough;
  unmount: () => void;
  rerender: (next: React.ReactElement) => void;
}> {
  const { stdout, stdin } = createStreams(columns);
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 20));
  return {
    stdout,
    rerender: (next) => {
      root.render(next);
    },
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

function getScreen(stdout: PassThrough): {
  width: number;
  height: number;
} & Record<string, unknown> {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { frontFrame?: { screen?: { width: number; height: number } } }
    | undefined;
  const screen = instance?.frontFrame?.screen;
  if (!screen) {
    throw new Error("no front frame");
  }
  return screen as never;
}

function rowText(stdout: PassThrough, y: number): string {
  const screen = getScreen(stdout);
  let row = "";
  for (let x = 0; x < screen.width; x += 1) {
    row += charInCellAt(screen as never, x, y) ?? " ";
  }
  return row;
}

describe("ComposerBuffer", () => {
  test("clears trailing cells from the previous frame when the buffer shrinks", async () => {
    const longValue = "hello world!!!";
    const { stdout, rerender, unmount } = await mount(
      <Box width={32}>
        <ComposerBuffer
          value={longValue}
          cursor={longValue.length}
          promptPrefix=""
          cursorActive={true}
        />
      </Box>,
      32,
    );

    rerender(
      <Box width={32}>
        <ComposerBuffer
          value="hi"
          cursor={2}
          promptPrefix=""
          cursorActive={true}
        />
      </Box>,
    );
    await new Promise((r) => setTimeout(r, 20));

    // After the buffer shrinks, the previous render's cells beyond the
    // new content's end must be cleared (charInCellAt returns ' ' /
    // emptyStyleId). The pre-fix single-Text rendering could leave
    // stranded cells here when the line shortened across frames.
    const screen = getScreen(stdout);
    for (let x = 3; x < longValue.length; x += 1) {
      const ch = charInCellAt(screen as never, x, 0) ?? " ";
      expect(ch.trim()).toBe("");
      const cell = cellAt(screen as never, x, 0);
      expect(cell?.styleId ?? 0).toBe(0);
    }

    unmount();
  });

  test("renders argumentHint as dim ghost text past the cursor at end-of-buffer", async () => {
    const value = "/run";
    const { stdout, unmount } = await mount(
      <Box width={40}>
        <ComposerBuffer
          value={value}
          cursor={value.length}
          promptPrefix=""
          cursorActive={true}
          argumentHint=" do a thing"
        />
      </Box>,
      40,
    );

    const row0 = rowText(stdout, 0);
    expect(row0).toContain("/run");
    expect(row0).toContain("do a thing");
    unmount();
  });

  test("renders placeholder when buffer is empty", async () => {
    const { stdout, unmount } = await mount(
      <Box width={40}>
        <ComposerBuffer
          value=""
          cursor={0}
          promptPrefix=""
          cursorActive={true}
          placeholder="ask AgenC"
        />
      </Box>,
      40,
    );

    const row0 = rowText(stdout, 0).replace(/\s+$/u, "");
    expect(row0).toContain("ask AgenC");
    unmount();
  });
});
