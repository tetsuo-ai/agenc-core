import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const keybindingHarness = vi.hoisted(() => ({
  deferredTaskIds: new Set<string>(),
  handlers: {} as Record<string, () => void>,
  logError: vi.fn(),
  pendingReads: new Map<string, (result: { content: string }) => void>(),
  readCounts: {} as Record<string, number>,
  rejectOnRead: {} as Record<string, number>,
  tails: {} as Record<string, string>,
}));

vi.mock("../../../src/utils/fsOperations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/utils/fsOperations.js")>()),
  tailFile: vi.fn(async (path: string) => {
    const taskId = /\/tmp\/(.+)\.log$/u.exec(path)?.[1] ?? path;
    const readCount = (keybindingHarness.readCounts[taskId] ?? 0) + 1;
    keybindingHarness.readCounts[taskId] = readCount;
    if (keybindingHarness.rejectOnRead[taskId] === readCount) {
      throw new Error(`tail failed for ${taskId}`);
    }
    if (keybindingHarness.deferredTaskIds.has(taskId)) {
      return new Promise<{ content: string }>((resolve) => {
        keybindingHarness.pendingReads.set(taskId, resolve);
      });
    }
    return { content: keybindingHarness.tails[taskId] ?? defaultTestTail() };
  }),
}));

vi.mock("../../../src/utils/task/diskOutput.js", () => ({
  getTaskOutputPath: (taskId: string) => `/tmp/${taskId}.log`,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => void>) => {
    keybindingHarness.handlers = handlers;
  },
}));

vi.mock("../../../src/utils/log.js", () => ({
  logError: keybindingHarness.logError,
}));

import { createRoot } from "../../../src/tui/ink.js";
import { getInkInstance } from "../../../src/tui/ink/instances.js";
import { cellAt } from "../../../src/tui/ink/screen.js";
import { AppStateProvider, getDefaultAppState, type AppState, useSetAppState } from "../../../src/tui/state/AppState.js";
import { TestSurface, TestSurfaceView } from "../../../src/tui/workbench/surfaces/TestSurface.js";
import { renderToString } from "../../../src/utils/staticRender.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

describe("TestSurface", () => {
  beforeEach(() => {
    keybindingHarness.deferredTaskIds = new Set();
    keybindingHarness.handlers = {};
    keybindingHarness.logError.mockReset();
    keybindingHarness.pendingReads = new Map();
    keybindingHarness.readCounts = {};
    keybindingHarness.rejectOnRead = {};
    keybindingHarness.tails = {};
  });

  it("clamps stale selection to the last parsed failure", async () => {
    const output = await renderToString(
      <TestSurfaceView
        failures={[
          {
            id: "first",
            name: "first failure",
            location: { file: "src/first.ts", line: 4 },
            message: "first message",
          },
          {
            id: "second",
            name: "second failure",
            location: { file: "src/second.ts", line: 9 },
            message: "second message",
          },
        ]}
        selected={99}
        focused={true}
      />,
      80,
    );

    expect(output).toContain("second failure");
    expect(output).toContain("second message");
  });

  it("renders missing task and empty parsed output states", async () => {
    const missingTaskOutput = await renderTestSurface({
      selectedShellTaskId: null,
      tasks: {},
    });
    keybindingHarness.tails["shell-empty"] = "all tests passed\nno failure details";
    const emptyOutput = await renderTestSurface({
      selectedShellTaskId: "shell-empty",
      tasks: {
        "shell-empty": shellTask("shell-empty", "empty test", "completed"),
      },
    });

    expect(missingTaskOutput).toContain("No test task selected");
    expect(emptyOutput).toContain("No parsed test failures");
  });

  it("keeps top navigation separate from opening the selected failure", async () => {
    const changes: AppState[] = [];
    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
            "shell-1": {
              id: "shell-1",
              type: "local_bash",
              status: "completed",
              description: "npm test",
              command: "npm test",
              startTime: 1_000,
              outputFile: "urn:agenc:task:shell-1:output",
              outputOffset: 0,
              notified: false,
            } as any,
          },
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "test",
            selectedShellTaskId: "shell-1",
          },
        }}
        onChangeAppState={({ newState }) => changes.push(newState)}
      >
        <TestSurface focused={true} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("first failure");

    keybindingHarness.handlers["surface:top"]?.();

    expect(changes).toHaveLength(0);

    keybindingHarness.handlers["surface:open"]?.();

    expect(changes.at(-1)?.workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      activeFilePath: "src/first.ts",
      activeFileLine: 4,
      focusedPane: "surface",
    });
  });

  it("routes surface open, attach, and close keybindings", async () => {
    const changes: AppState[] = [];
    await renderTestSurface({
      selectedShellTaskId: "shell-1",
      tasks: {
        "shell-1": shellTask("shell-1", "current test", "completed"),
      },
      onChange: changes,
      workbench: {
        focusedPane: "composer",
      },
    });

    keybindingHarness.handlers["surface:openKeepFocus"]?.();
    expect(changes.at(-1)?.workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      activeFilePath: "src/first.ts",
      activeFileLine: 4,
      focusedPane: "composer",
    });

    keybindingHarness.handlers["surface:attach"]?.();
    expect(changes.at(-1)?.workbench.attachments.at(-1)).toMatchObject({
      id: "task-error:shell-1:src/first.ts:4",
      kind: "task-error",
      path: "src/first.ts",
      line: 4,
      taskId: "shell-1",
      label: "first failure",
    });

    keybindingHarness.handlers["workbench:closeSurface"]?.();
    expect(changes.at(-1)?.workbench.activeSurfaceMode).toBe("transcript");
  });

  it("normalizes test failure paths when opening buffers", async () => {
    keybindingHarness.tails["shell-windows"] = [
      "FAIL windows-style failure",
      "src\\nested\\first.test.ts:4:1",
      "first message",
    ].join("\n");
    const changes: AppState[] = [];
    await renderTestSurface({
      selectedShellTaskId: "shell-windows",
      tasks: {
        "shell-windows": shellTask("shell-windows", "windows path test", "completed"),
      },
      onChange: changes,
      workbench: {
        focusedPane: "composer",
      },
    });

    keybindingHarness.handlers["surface:openKeepFocus"]?.();
    expect(changes.at(-1)?.workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      activeFilePath: "src/nested/first.test.ts",
      activeFileLine: 4,
      focusedPane: "composer",
    });

    keybindingHarness.handlers["surface:open"]?.();
    expect(changes.at(-1)?.workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      activeFilePath: "src/nested/first.test.ts",
      activeFileLine: 4,
      focusedPane: "surface",
    });
  });

  it("ignores attach and open commands when the selected failure has no location", async () => {
    keybindingHarness.tails["shell-no-location"] = [
      "FAIL failure without location",
      "expected true to be false",
    ].join("\n");
    const changes: AppState[] = [];
    const output = await renderTestSurface({
      selectedShellTaskId: "shell-no-location",
      tasks: {
        "shell-no-location": shellTask("shell-no-location", "test without location", "completed"),
      },
      onChange: changes,
    });

    expect(output).toContain("failure without location");

    keybindingHarness.handlers["surface:open"]?.();
    keybindingHarness.handlers["surface:openKeepFocus"]?.();
    keybindingHarness.handlers["surface:attach"]?.();

    expect(changes).toHaveLength(0);
  });

  it("navigates from the clamped visible failure after output shrinks", async () => {
    keybindingHarness.tails["shell-1"] = numberedFailureTail(12);
    const changes: AppState[] = [];
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
            tasks: {
              "shell-1": shellTask("shell-1", "current test", "running"),
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "test",
              selectedShellTaskId: "shell-1",
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <TestSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      keybindingHarness.handlers["surface:pageDown"]?.();
      await sleep();
      keybindingHarness.tails["shell-1"] = numberedFailureTail(2);
      await sleep(1_200);

      expect(compact(screenText(stdout))).toContain("failure2");

      keybindingHarness.handlers["surface:up"]?.();
      await sleep();
      keybindingHarness.handlers["surface:open"]?.();

      expect(changes.at(-1)?.workbench).toMatchObject({
        activeSurfaceMode: "buffer",
        activeFilePath: "src/failure-1.ts",
        activeFileLine: 1,
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("routes bottom, page-up, and down navigation from the visible selection", async () => {
    keybindingHarness.tails["shell-1"] = numberedFailureTail(12);
    const changes: AppState[] = [];
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
            tasks: {
              "shell-1": shellTask("shell-1", "current test", "completed"),
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "test",
              selectedShellTaskId: "shell-1",
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <TestSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      keybindingHarness.handlers["surface:bottom"]?.();
      await sleep();
      keybindingHarness.handlers["surface:pageUp"]?.();
      await sleep();
      keybindingHarness.handlers["surface:down"]?.();
      await sleep();
      keybindingHarness.handlers["surface:open"]?.();

      expect(compact(screenText(stdout))).toContain("failure3");
      expect(changes.at(-1)?.workbench).toMatchObject({
        activeSurfaceMode: "buffer",
        activeFilePath: "src/failure-3.ts",
        activeFileLine: 3,
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("ignores tail reads that resolve after unmount", async () => {
    keybindingHarness.deferredTaskIds.add("shell-1");
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
            tasks: {
              "shell-1": shellTask("shell-1", "current test", "completed"),
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "test",
              selectedShellTaskId: "shell-1",
            },
          }}
        >
          <TestSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      const resolveRead = keybindingHarness.pendingReads.get("shell-1");
      expect(resolveRead).toBeTypeOf("function");

      root.unmount();
      resolveRead?.({ content: defaultTestTail() });
      await sleep();

      expect(keybindingHarness.logError).not.toHaveBeenCalled();
    } finally {
      stdin.end();
      stdout.end();
    }
  });

  it("clears stale failure output immediately when switching selected test tasks", async () => {
    keybindingHarness.tails["shell-old"] = [
      "FAIL old failure",
      "src/old-test.ts:4:1",
      "old message",
    ].join("\n");
    keybindingHarness.deferredTaskIds.add("shell-new");
    let selectTask: ((taskId: string) => void) | null = null;
    const changes: AppState[] = [];
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
            tasks: {
              "shell-old": shellTask("shell-old", "old test", "completed"),
              "shell-new": shellTask("shell-new", "new test", "running"),
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "test",
              selectedShellTaskId: "shell-old",
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <TestTaskSelector onReady={(setter) => { selectTask = setter; }} />
          <TestSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      selectTask?.("shell-new");
      await sleep(25);

      keybindingHarness.handlers["surface:open"]?.();
      expect(changes.at(-1)?.workbench.activeFilePath).not.toBe("src/old-test.ts");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("keeps parsed failures visible when a later tail poll fails", async () => {
    keybindingHarness.rejectOnRead["shell-1"] = 2;
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
            tasks: {
              "shell-1": shellTask("shell-1", "current test", "running"),
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "test",
              selectedShellTaskId: "shell-1",
            },
          }}
        >
          <TestSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      expect(compact(screenText(stdout))).toContain("firstfailure");

      await sleep(1_200);

      expect(compact(screenText(stdout))).toContain("firstfailure");
      expect(compact(screenText(stdout))).not.toContain("Noparsedtestfailures");
      expect(keybindingHarness.logError.mock.calls.some(([error]) =>
        error instanceof Error && error.message === "tail failed for shell-1"
      )).toBe(true);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});

function TestTaskSelector({
  onReady,
}: {
  readonly onReady: (selectTask: (taskId: string) => void) => void;
}): null {
  const setAppState = useSetAppState();
  React.useEffect(() => {
    onReady((selectedShellTaskId: string) => {
      setAppState((state) => ({
        ...state,
        workbench: {
          ...state.workbench,
          selectedShellTaskId,
        },
      }));
    });
  }, [onReady, setAppState]);
  return null;
}

async function renderTestSurface(options: {
  readonly selectedShellTaskId: string | null;
  readonly tasks: AppState["tasks"];
  readonly onChange?: AppState[];
  readonly workbench?: Partial<NonNullable<AppState["workbench"]>>;
  readonly focused?: boolean;
}): Promise<string> {
  return renderToString(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        tasks: options.tasks,
        workbench: {
          ...getDefaultAppState().workbench,
          activeSurfaceMode: "test",
          selectedShellTaskId: options.selectedShellTaskId,
          ...options.workbench,
        },
      }}
      onChangeAppState={({ newState }) => options.onChange?.push(newState)}
    >
      <TestSurface focused={options.focused ?? true} />
    </AppStateProvider>,
    100,
  );
}

function defaultTestTail(): string {
  return [
    "FAIL first failure",
    "src/first.ts:4:1",
    "first message",
    "FAIL second failure",
    "src/second.ts:9:1",
    "second message",
  ].join("\n");
}

function numberedFailureTail(count: number): string {
  const lines: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    lines.push(
      `FAIL failure ${index}`,
      `src/failure-${index}.ts:${index}:1`,
      `message ${index}`,
    );
  }
  return lines.join("\n");
}

function shellTask(
  id: string,
  description: string,
  status: "running" | "completed",
): any {
  return {
    id,
    type: "local_bash",
    status,
    description,
    command: "npm test",
    startTime: id === "shell-new" ? 2_000 : 1_000,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
  };
}

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
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 120;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 24;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true;
  stdout.resume();

  return {
    stdin,
    stdout,
  };
}

function sleep(ms = 200): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}

function screenText(stdout: PassThrough): string {
  const instance = getInkInstance(stdout as unknown as NodeJS.WriteStream) as
    | { readonly frontFrame?: { readonly screen?: { readonly width: number; readonly height: number } } }
    | undefined;
  const screen = instance?.frontFrame?.screen;
  if (!screen) return "";
  const rows: string[] = [];
  for (let row = 0; row < screen.height; row += 1) {
    const chars: string[] = [];
    for (let column = 0; column < screen.width; column += 1) {
      chars.push(cellAt(screen, column, row)?.char ?? " ");
    }
    rows.push(chars.join("").trimEnd());
  }
  return rows.join("\n");
}
