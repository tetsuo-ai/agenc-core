import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const previewHarness = vi.hoisted(() => ({
  handlers: {} as Record<string, () => void>,
  calls: [] as Array<{
    readonly filePath: string;
    readonly offset: number;
    readonly signal: AbortSignal | undefined;
    readonly resolve: (result: {
      readonly content: string;
      readonly lineCount: number;
      readonly totalLines: number;
      readonly totalBytes: number;
      readonly readBytes: number;
      readonly mtimeMs: number;
    }) => void;
    readonly reject: (error: unknown) => void;
  }>,
}));

vi.mock("../../../src/utils/readFileInRange.js", () => ({
  readFileInRange: vi.fn((
    filePath: string,
    offset: number,
    _limit: number,
    _encoding: unknown,
    signal?: AbortSignal,
  ) => {
    let resolve!: (result: {
      readonly content: string;
      readonly lineCount: number;
      readonly totalLines: number;
      readonly totalBytes: number;
      readonly readBytes: number;
      readonly mtimeMs: number;
    }) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    previewHarness.calls.push({ filePath, offset, signal, resolve, reject });
    return promise;
  }),
}));

vi.mock("../../../src/tui/workbench/project-tree/gitStatus.js", () => ({
  collectGitStatus: vi.fn(async () => new Map()),
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useInputCapture: () => {},
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => void>) => {
    previewHarness.handlers = handlers;
  },
}));

import { createRoot } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState, type AppState, useSetAppState } from "../../../src/tui/state/AppState.js";
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

function sleep(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPreviewRead(
  predicate: (call: (typeof previewHarness.calls)[number]) => boolean,
): Promise<(typeof previewHarness.calls)[number]> {
  for (let index = 0; index < 20; index += 1) {
    const call = previewHarness.calls.find(predicate);
    if (call) return call;
    await sleep(25);
  }
  throw new Error("Preview read did not start");
}

function PreviewTargetController({
  onReady,
}: {
  readonly onReady: (setPreviewTarget: (filePath: string, line: number) => void) => void;
}): null {
  const setAppState = useSetAppState();
  React.useEffect(() => {
    onReady((filePath: string, line: number) => {
      setAppState((state) => ({
        ...state,
        workbench: {
          ...state.workbench,
          activeSurfaceMode: "preview",
          activeFilePath: filePath,
          activeFileLine: line,
        },
      }));
    });
  }, [onReady, setAppState]);
  return null;
}

describe("PreviewSurface clamped content", () => {
  beforeEach(() => {
    previewHarness.handlers = {};
    previewHarness.calls = [];
  });

  it("does not use the previous file body after switching to a clamped preview target", async () => {
    let setPreviewTarget: ((filePath: string, line: number) => void) | null = null;
    const changes: AppState[] = [];
    const { stdin, stdout, output } = createStreams();
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
              activeFilePath: "old.ts",
              activeFileLine: 1,
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <PreviewTargetController onReady={(setter) => { setPreviewTarget = setter; }} />
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const oldRead = await waitForPreviewRead((call) => call.filePath.endsWith("old.ts") && call.offset === 0);
      oldRead.resolve({
        content: "old body\nold stale body",
        lineCount: 2,
        totalLines: 2,
        totalBytes: 24,
        readBytes: 24,
        mtimeMs: 1,
      });
      await sleep();

      expect(compact(output())).toContain("oldstalebody");

      setPreviewTarget?.("new.ts", 99);

      const clampedRead = await waitForPreviewRead((call) => call.filePath.endsWith("new.ts") && call.offset === 98);
      clampedRead.resolve({
        content: "",
        lineCount: 0,
        totalLines: 2,
        totalBytes: 9,
        readBytes: 0,
        mtimeMs: 2,
      });
      await sleep();

      previewHarness.handlers["surface:attach"]?.();

      expect(changes.at(-1)?.workbench.attachments.at(-1)).toMatchObject({
        id: "file-range:new.ts:2-2",
        label: "new.ts:2",
        path: "new.ts",
        line: 2,
        endLine: 2,
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}
