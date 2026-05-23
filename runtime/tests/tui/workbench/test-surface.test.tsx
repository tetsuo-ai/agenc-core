import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const keybindingHarness = vi.hoisted(() => ({
  deferredTaskIds: new Set<string>(),
  handlers: {} as Record<string, () => void>,
  pendingReads: new Map<string, (result: { content: string }) => void>(),
  tails: {} as Record<string, string>,
}));

vi.mock("../../../src/utils/fsOperations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/utils/fsOperations.js")>()),
  tailFile: vi.fn(async (path: string) => {
    const taskId = /\/tmp\/(.+)\.log$/u.exec(path)?.[1] ?? path;
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

import { createRoot } from "../../../src/tui/ink.js";
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
    keybindingHarness.pendingReads = new Map();
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
