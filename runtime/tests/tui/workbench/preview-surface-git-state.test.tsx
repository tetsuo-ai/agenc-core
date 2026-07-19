import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const previewHarness = vi.hoisted(() => ({
  logError: vi.fn(),
  statusReads: [] as Array<{
    readonly resolve: (status: Map<string, string>) => void;
    readonly reject: (error: unknown) => void;
  }>,
}));

vi.mock("../../../src/utils/readFileInRange.js", () => ({
  readFileInRange: vi.fn(async () => ({
    content: "preview body",
    lineCount: 1,
    totalLines: 1,
    totalBytes: 12,
    readBytes: 12,
    mtimeMs: 1,
  })),
}));

vi.mock("../../../src/tui/workbench/project-tree/gitStatus.js", () => ({
  collectGitStatus: vi.fn(() => {
    let resolve!: (status: Map<string, string>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Map<string, string>>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    previewHarness.statusReads.push({ resolve, reject });
    return promise;
  }),
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useInputCapture: () => {},
  useKeybinding: () => {},
  useKeybindings: () => {},
}));

vi.mock("../../../src/utils/log.js", () => ({
  logError: previewHarness.logError,
}));

import { createRoot } from "../../../src/tui/ink.js";
import { getInkInstance } from "../../../src/tui/ink/instances.js";
import { cellAt } from "../../../src/tui/ink/screen.js";
import {
  AppStateProvider,
  getDefaultAppState,
  useSetAppState,
} from "../../../src/tui/state/AppState.js";
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

  return {
    stdin,
    stdout,
  };
}

function sleep(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForStatusRead(index: number): Promise<(typeof previewHarness.statusReads)[number]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = previewHarness.statusReads[index];
    if (read) return read;
    await sleep(25);
  }
  throw new Error(`Preview git status read ${index} did not start`);
}

function PreviewTargetController({
  onReady,
}: {
  readonly onReady: (setPreviewTarget: (filePath: string) => void) => void;
}): null {
  const setAppState = useSetAppState();
  React.useEffect(() => {
    onReady((filePath: string) => {
      setAppState((state) => ({
        ...state,
        workbench: {
          ...state.workbench,
          activeSurfaceMode: "preview",
          activeFilePath: filePath,
          activeFileLine: 1,
        },
      }));
    });
  }, [onReady, setAppState]);
  return null;
}

describe("PreviewSurface git state", () => {
  beforeEach(() => {
    previewHarness.logError.mockReset();
    previewHarness.statusReads = [];
  });

  it("does not show the previous file git state after switching preview targets", async () => {
    let setPreviewTarget: ((filePath: string) => void) | null = null;
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
              activeFilePath: "old.ts",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewTargetController onReady={(setter) => { setPreviewTarget = setter; }} />
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const oldStatusRead = await waitForStatusRead(0);
      oldStatusRead.resolve(new Map([["old.ts", "modified"]]));
      await sleep();
      expect(screenLine(stdout, 0)).toContain("old.ts [read-only, modified]");

      setPreviewTarget?.("new.ts");
      await waitForStatusRead(1);
      await sleep();

      expect(screenLine(stdout, 0)).toContain("new.ts [read-only");
      expect(screenLine(stdout, 0)).not.toContain("modified");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("ignores stale git status failures after switching preview targets", async () => {
    let setPreviewTarget: ((filePath: string) => void) | null = null;
    const staleError = new Error("old status failed");
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
              activeFilePath: "old.ts",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewTargetController onReady={(setter) => { setPreviewTarget = setter; }} />
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const oldStatusRead = await waitForStatusRead(0);
      setPreviewTarget?.("new.ts");
      await waitForStatusRead(1);

      oldStatusRead.reject(staleError);
      await sleep();

      expect(previewHarness.logError).not.toHaveBeenCalledWith(staleError);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("ignores stale git status successes after switching preview targets", async () => {
    let setPreviewTarget: ((filePath: string) => void) | null = null;
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
              activeFilePath: "old.ts",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewTargetController onReady={(setter) => { setPreviewTarget = setter; }} />
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const oldStatusRead = await waitForStatusRead(0);
      setPreviewTarget?.("new.ts");
      await waitForStatusRead(1);

      oldStatusRead.resolve(new Map([["old.ts", "modified"]]));
      await sleep();

      expect(screenLine(stdout, 0)).toContain("new.ts [read-only");
      expect(screenLine(stdout, 0)).not.toContain("modified");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("logs git status refresh failures without showing stale status", async () => {
    const statusError = new Error("status unavailable");
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
              activeFilePath: "target.ts",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const statusRead = await waitForStatusRead(0);
      statusRead.reject(statusError);
      await sleep();

      expect(previewHarness.logError).toHaveBeenCalledWith(statusError);
      expect(screenLine(stdout, 0)).toContain("target.ts [read-only");
      expect(screenLine(stdout, 0)).not.toContain("modified");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});

function screenLine(stdout: PassThrough, row: number): string {
  const instance = getInkInstance(stdout as unknown as NodeJS.WriteStream) as
    | { readonly frontFrame?: { readonly screen?: { readonly width: number; readonly height: number } } }
    | undefined;
  const screen = instance?.frontFrame?.screen;
  if (!screen) return "";
  const chars: string[] = [];
  for (let column = 0; column < screen.width; column += 1) {
    chars.push(cellAt(screen, column, row)?.char ?? " ");
  }
  return chars.join("").trimEnd();
}
