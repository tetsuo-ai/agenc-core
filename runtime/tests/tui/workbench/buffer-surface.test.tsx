import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWithCwdOverride } from "../../../src/utils/cwd.js";
import { createRoot } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import {
  getWorkbenchBufferStore,
  resetWorkbenchBufferStoreForTesting,
} from "../../../src/tui/workbench/buffer/BufferStore.js";
import { BufferSurface } from "../../../src/tui/workbench/surfaces/BufferSurface.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
  readonly output: () => string;
} {
  let output = "";
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 80;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 24;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true;
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  return {
    stdin,
    stdout,
    output: () => stripAnsi(output),
  };
}

function sleep(ms = 100): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-buffer-surface-"));
});

afterEach(async () => {
  resetWorkbenchBufferStoreForTesting();
  await rm(dir, { recursive: true, force: true });
});

describe("BufferSurface", () => {
  it("renders editable buffer content without overflowing the terminal", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <BufferSurface focused={false} />
          </AppStateProvider>,
        );
        await sleep();
      });

      const frame = output();
      expect(frame).toContain("BUFFER");
      expect(frame).toContain("target.ts");
      expect(frame).toMatch(/const\s+value\s*=\s*1;/u);
      for (const line of frame.split(/[\r\n]+/u)) {
        expect(line.length).toBeLessThanOrEqual(80);
      }
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("treats printable q as text input when focused", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <BufferSurface focused={true} />
          </AppStateProvider>,
        );
        await sleep();
      });

      stdin.write("q");
      await sleep();

      expect(getWorkbenchBufferStore().getText()).toBe("qconst value = 1;\n");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
