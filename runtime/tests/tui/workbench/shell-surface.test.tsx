import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shellHarness = vi.hoisted(() => ({
  deferredTaskIds: new Set<string>(),
  handlers: {} as Record<string, () => void>,
  pendingReads: new Map<string, (result: { content: string }) => void>(),
  tails: {} as Record<string, string>,
}));

vi.mock("../../../src/utils/fsOperations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/utils/fsOperations.js")>()),
  tailFile: vi.fn(async (path: string) => {
    const taskId = /\/tmp\/(.+)\.log$/u.exec(path)?.[1] ?? path;
    if (shellHarness.deferredTaskIds.has(taskId)) {
      return new Promise<{ content: string }>((resolve) => {
        shellHarness.pendingReads.set(taskId, resolve);
      });
    }
    return { content: shellHarness.tails[taskId] ?? "" };
  }),
}));

vi.mock("../../../src/utils/task/diskOutput.js", () => ({
  getTaskOutputPath: (taskId: string) => `/tmp/${taskId}.log`,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => void>) => {
    shellHarness.handlers = handlers;
  },
}));

import { createRoot } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState, type AppState, useSetAppState } from "../../../src/tui/state/AppState.js";
import { ShellSurface } from "../../../src/tui/workbench/surfaces/ShellSurface.js";
import { renderToString } from "../../../src/utils/staticRender.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

describe("ShellSurface", () => {
  beforeEach(() => {
    shellHarness.deferredTaskIds = new Set();
    shellHarness.handlers = {};
    shellHarness.pendingReads = new Map();
    shellHarness.tails = {};
  });

  it("ignores stale selected ids that point at non-shell tasks", async () => {
    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
            "agent-1": {
              id: "agent-1",
              type: "local_agent",
              status: "running",
              description: "agent work",
              startTime: 1_000,
              outputFile: "urn:agenc:task:agent-1:output",
              outputOffset: 0,
              notified: false,
            } as any,
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
            activeSurfaceMode: "shell",
            selectedShellTaskId: "agent-1",
          },
        }}
      >
        <ShellSurface focused={true} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("SHELL - completed - npm test");
    expect(output).not.toContain("agent work");
  });

  it("shows an empty shell state instead of rendering a selected agent task", async () => {
    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
            "agent-1": {
              id: "agent-1",
              type: "local_agent",
              status: "running",
              description: "agent work",
              startTime: 1_000,
              outputFile: "urn:agenc:task:agent-1:output",
              outputOffset: 0,
              notified: false,
            } as any,
          },
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "shell",
            selectedShellTaskId: "agent-1",
          },
        }}
      >
        <ShellSurface focused={true} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("No shell task selected");
    expect(output).not.toContain("agent work");
  });

  it("falls back to the running newest shell task after stale selection", async () => {
    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          tasks: {
            "shell-old": {
              id: "shell-old",
              type: "local_bash",
              status: "completed",
              description: "old completed shell",
              command: "npm run old",
              startTime: 1_000,
              outputFile: "urn:agenc:task:shell-old:output",
              outputOffset: 0,
              notified: false,
            } as any,
            "shell-new": {
              id: "shell-new",
              type: "local_bash",
              status: "running",
              description: "new running shell",
              command: "npm test",
              startTime: 2_000,
              outputFile: "urn:agenc:task:shell-new:output",
              outputOffset: 0,
              notified: false,
            } as any,
          },
          workbench: {
            ...getDefaultAppState().workbench,
            activeSurfaceMode: "shell",
            selectedShellTaskId: "missing-shell",
          },
        }}
      >
        <ShellSurface focused={true} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("SHELL - running - new running shell");
    expect(output).not.toContain("old completed shell");
  });

  it("clears stale tail content immediately when switching selected shell tasks", async () => {
    shellHarness.tails["shell-old"] = [
      "old task failed",
      "src/old-task.ts:4:1",
    ].join("\n");
    shellHarness.deferredTaskIds.add("shell-new");
    let selectTask: ((taskId: string) => void) | null = null;
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
            tasks: {
              "shell-old": shellTask("shell-old", "old shell", "completed"),
              "shell-new": shellTask("shell-new", "new shell", "running"),
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "shell",
              selectedShellTaskId: "shell-old",
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <ShellTaskSelector onReady={(setter) => { selectTask = setter; }} />
          <ShellSurface focused={true} />
        </AppStateProvider>,
      );
      await sleep();

      expect(compact(output())).toContain("src/old-task.ts:4");

      const beforeSwitch = output();
      selectTask?.("shell-new");
      await sleep(25);

      const afterSwitch = output().slice(beforeSwitch.length);
      expect(compact(afterSwitch)).toContain("running-newshell");
      expect(compact(afterSwitch)).not.toContain("src/old-task.ts");

      shellHarness.handlers["surface:open"]?.();
      expect(changes.at(-1)?.workbench.activeFilePath).not.toBe("src/old-task.ts");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});

function ShellTaskSelector({
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
  readonly output: () => string;
} {
  let output = "";
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 120;
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

function sleep(ms = 200): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}
