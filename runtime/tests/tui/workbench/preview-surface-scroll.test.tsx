import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const previewHarness = vi.hoisted(() => ({
  handlers: {} as Record<string, () => void>,
  readOffsets: [] as number[],
}));

vi.mock("../../../src/utils/readFileInRange.js", () => ({
  readFileInRange: vi.fn(async (
    _filePath: string,
    offset: number,
  ) => {
    previewHarness.readOffsets.push(offset);
    return {
      content: offset <= 0 ? "one\ntwo" : offset === 1 ? "two" : "",
      lineCount: offset <= 0 ? 2 : offset === 1 ? 1 : 0,
      totalLines: 2,
      totalBytes: 7,
      readBytes: offset <= 0 ? 7 : offset === 1 ? 3 : 0,
      mtimeMs: 1,
    };
  }),
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

import { createRoot } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { PreviewSurface } from "../../../src/tui/workbench/surfaces/PreviewSurface.js";

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

function sleep(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("PreviewSurface scrolling", () => {
  beforeEach(() => {
    previewHarness.handlers = {};
    previewHarness.readOffsets = [];
  });

  it("does not request preview ranges past the final file line", async () => {
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "target.txt",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      expect(previewHarness.readOffsets).toContain(0);

      for (let index = 0; index < 5; index += 1) {
        previewHarness.handlers["surface:down"]?.();
      }
      await sleep();

      expect(Math.max(...previewHarness.readOffsets)).toBeLessThanOrEqual(1);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
