import { PassThrough } from "node:stream";
import path from "node:path";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from "../../../src/services/lsp/LSPDiagnosticRegistry.js";
import type { TaskState } from "../../../src/tasks/types.js";
import {
  notifyPreviewFileChanged,
  resetPreviewFileRevisionsForTesting,
} from "../../../src/tui/workbench/previewInvalidation.js";

type PreviewReadResult = {
  readonly content: string;
  readonly lineCount?: number;
  readonly totalLines?: number;
  readonly totalBytes: number;
  readonly readBytes: number;
  readonly mtimeMs: number;
};

type PreviewReadCall = {
  readonly filePath: string;
  readonly offset: number;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (result: PreviewReadResult) => void;
  readonly reject: (error: unknown) => void;
};

const previewHarness = vi.hoisted(() => ({
  handlers: {} as Record<string, () => void>,
  calls: [] as PreviewReadCall[],
}));

vi.mock("../../../src/utils/readFileInRange.js", () => ({
  readFileInRange: vi.fn(
    (
      filePath: string,
      offset: number,
      _limit: number,
      _encoding: unknown,
      signal?: AbortSignal,
    ) => {
      let resolve!: (result: PreviewReadResult) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = (result: PreviewReadResult) => resolvePromise(result);
        reject = rejectPromise;
      });
      previewHarness.calls.push({ filePath, offset, signal, resolve, reject });
      return promise;
    },
  ),
}));

vi.mock("../../../src/tui/workbench/project-tree/gitStatus.js", () => ({
  collectGitStatus: vi.fn(async () => new Map([["target.ts", "modified"]])),
}));

vi.mock(
  "../../../src/tui/keybindings/useKeybinding.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../src/tui/keybindings/useKeybinding.js")
    >()),
    useKeybinding: () => {},
    useKeybindings: (handlers: Record<string, () => void>) => {
      previewHarness.handlers = handlers;
    },
  }),
);

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
  readonly output: () => string;
} {
  let output = "";
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (
    stdout as unknown as { columns: number; rows: number; isTTY: boolean }
  ).columns = 80;
  (
    stdout as unknown as { columns: number; rows: number; isTTY: boolean }
  ).rows = 24;
  (
    stdout as unknown as { columns: number; rows: number; isTTY: boolean }
  ).isTTY = true;
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  return {
    stdin,
    stdout,
    output: () => stripAnsi(output),
  };
}

function sleep(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPreviewRead(
  predicate: (call: PreviewReadCall) => boolean,
): Promise<PreviewReadCall> {
  for (let index = 0; index < 20; index += 1) {
    const call = previewHarness.calls.find(predicate);
    if (call) return call;
    await sleep(25);
  }
  throw new Error("Preview read did not start");
}

async function waitForPreviewReadCount(count: number): Promise<PreviewReadCall> {
  for (let index = 0; index < 20; index += 1) {
    if (previewHarness.calls.length >= count) {
      return previewHarness.calls[count - 1]!;
    }
    await sleep(25);
  }
  throw new Error(`Preview read count did not reach ${count}`);
}

function resolvePreviewRead(
  call: PreviewReadCall,
  result: Partial<PreviewReadResult> & { readonly content: string },
): void {
  call.resolve({
    totalBytes: Buffer.byteLength(result.content),
    readBytes: Buffer.byteLength(result.content),
    mtimeMs: 1,
    ...result,
  });
}

function agentTask(
  overrides: Partial<TaskState> & Pick<TaskState, "id" | "status">,
): TaskState {
  return {
    type: "local_agent",
    description: "editing target.ts",
    startTime: 0,
    outputFile: "",
    outputOffset: 0,
    notified: false,
    agentId: "agent",
    prompt: "target.ts",
    agentType: "general",
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  } as TaskState;
}

function PreviewStateController({
  onReady,
}: {
  readonly onReady: (setTasks: (tasks: Record<string, TaskState>) => void) => void;
}): null {
  const setAppState = useSetAppState();
  React.useEffect(() => {
    onReady((tasks) => {
      setAppState((state) => ({
        ...state,
        tasks,
      }));
    });
  }, [onReady, setAppState]);
  return null;
}

function PreviewTargetController({
  onReady,
}: {
  readonly onReady: (
    setPreviewTarget: (filePath: string, line: number) => void,
  ) => void;
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

describe("PreviewSurface same-path invalidation", () => {
  beforeEach(() => {
    previewHarness.handlers = {};
    previewHarness.calls = [];
    resetPreviewFileRevisionsForTesting();
  });

  afterEach(() => {
    resetAllLSPDiagnosticState();
    resetPreviewFileRevisionsForTesting();
  });

  it("rereads and refreshes diagnostics after a same-path file revision", async () => {
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [
        {
          uri: path.resolve(process.cwd(), "target.ts"),
          diagnostics: [{ message: "stale", severity: "Error" }],
        },
      ],
    });

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

      const firstRead = await waitForPreviewRead((call) =>
        call.filePath.endsWith("target.ts"),
      );
      resolvePreviewRead(firstRead, {
        content: "old selected body",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();
      expect(currentScreenText(stdout)).toContain("old selected body");
      expect(currentScreenText(stdout)).toMatch(/1\s*diagnostic/u);

      notifyPreviewFileChanged(firstRead.filePath);
      const secondRead = await waitForPreviewReadCount(2);
      expect(secondRead.filePath).toBe(firstRead.filePath);
      expect(secondRead.offset).toBe(firstRead.offset);

      resolvePreviewRead(secondRead, {
        content: "new selected body",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();

      const frame = currentScreenText(stdout);
      expect(frame).toContain("new selected body");
      expect(frame).not.toContain("old selected body");
      expect(frame).toMatch(/1\s*diagnostic/u);
      expect(previewHarness.calls).toHaveLength(2);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("rereads once when a referencing task completes", async () => {
    let setTasks: ((tasks: Record<string, TaskState>) => void) | null = null;
    const runningTask = agentTask({
      id: "agent-1",
      status: "running",
      description: "editing target.ts",
    });
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
            tasks: { "agent-1": runningTask },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "target.ts",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewStateController
            onReady={(setter) => {
              setTasks = setter;
            }}
          />
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const firstRead = await waitForPreviewRead((call) =>
        call.filePath.endsWith("target.ts"),
      );
      resolvePreviewRead(firstRead, {
        content: "before agent finished",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();
      expect(currentScreenText(stdout)).toContain("before agent finished");
      expect(previewHarness.calls).toHaveLength(1);

      setTasks?.({
        "agent-1": agentTask({
          id: "agent-1",
          status: "completed",
          description: "editing target.ts",
          endTime: 10,
        }),
      });

      const secondRead = await waitForPreviewReadCount(2);
      expect(secondRead.offset).toBe(firstRead.offset);
      resolvePreviewRead(secondRead, {
        content: "after agent finished",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();

      const frame = currentScreenText(stdout);
      expect(frame).toContain("after agent finished");
      expect(frame).not.toContain("before agent finished");
      expect(previewHarness.calls).toHaveLength(2);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("does not reread when an unrelated task updates", async () => {
    let setTasks: ((tasks: Record<string, TaskState>) => void) | null = null;
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
          <PreviewStateController
            onReady={(setter) => {
              setTasks = setter;
            }}
          />
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const firstRead = await waitForPreviewRead((call) =>
        call.filePath.endsWith("target.ts"),
      );
      resolvePreviewRead(firstRead, {
        content: "unchanged selected body",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();

      setTasks?.({
        "agent-other": agentTask({
          id: "agent-other",
          status: "completed",
          description: "editing other.ts",
          prompt: "other.ts",
          endTime: 4,
        }),
      });
      await sleep(80);

      expect(previewHarness.calls).toHaveLength(1);
      expect(currentScreenText(stdout)).toContain("unchanged selected body");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("keeps the newest same-path read when an earlier invalidation settles late", async () => {
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

      const firstRead = await waitForPreviewRead((call) =>
        call.filePath.endsWith("target.ts"),
      );
      notifyPreviewFileChanged(firstRead.filePath);
      const secondRead = await waitForPreviewReadCount(2);

      expect(firstRead.signal?.aborted).toBe(true);

      resolvePreviewRead(secondRead, {
        content: "newest same-path body",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();
      expect(currentScreenText(stdout)).toContain("newest same-path body");

      resolvePreviewRead(firstRead, {
        content: "late first same-path body",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();

      const frame = currentScreenText(stdout);
      expect(frame).toContain("newest same-path body");
      expect(frame).not.toContain("late first same-path body");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("keeps A-to-B-to-A race protection after same-path invalidation is added", async () => {
    let setPreviewTarget: ((filePath: string, line: number) => void) | null =
      null;
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
              activeFilePath: "a.ts",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewTargetController
            onReady={(setter) => {
              setPreviewTarget = setter;
            }}
          />
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );

      const firstARead = await waitForPreviewRead((call) =>
        call.filePath.endsWith("a.ts"),
      );
      setPreviewTarget?.("b.ts", 1);
      const bRead = await waitForPreviewRead((call) =>
        call.filePath.endsWith("b.ts"),
      );
      setPreviewTarget?.("a.ts", 1);
      const newestARead = await waitForPreviewRead(
        (call) =>
          call.filePath.endsWith("a.ts") && call !== firstARead,
      );

      expect(firstARead.signal?.aborted).toBe(true);
      expect(bRead.signal?.aborted).toBe(true);

      resolvePreviewRead(newestARead, {
        content: "newest a body",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();
      resolvePreviewRead(bRead, {
        content: "late b body",
        lineCount: 1,
        totalLines: 1,
      });
      resolvePreviewRead(firstARead, {
        content: "late first a body",
        lineCount: 1,
        totalLines: 1,
      });
      await sleep();

      const frame = currentScreenText(stdout);
      expect(frame).toContain("newest a body");
      expect(frame).not.toContain("late b body");
      expect(frame).not.toContain("late first a body");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
