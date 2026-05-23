import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const explorerHarness = vi.hoisted(() => {
  const harness: {
    handlers: Record<string, () => void>;
    textInputProps: Array<Record<string, unknown>>;
    renameCalls: Array<readonly [string, string]>;
    cursorRow: Record<string, unknown> | null;
    snapshot: Record<string, unknown>;
    store: Record<string, unknown>;
  } = {
    handlers: {},
    textInputProps: [],
    renameCalls: [],
    cursorRow: {
      id: "src",
      path: "src",
      label: "src",
      kind: "directory",
      depth: 1,
      expanded: true,
      selected: true,
      focused: true,
      active: false,
      attached: false,
      searchHit: false,
      inFlight: false,
    },
    snapshot: {
      cwd: "/repo",
      loading: false,
      error: null,
      cursorPath: "src",
      activePath: "src/nested/app.ts",
      expandedPaths: ["src"],
      rows: [
        {
          id: "src",
          path: "src",
          label: "src",
          kind: "directory",
          depth: 1,
          expanded: true,
          selected: true,
          focused: true,
          active: false,
          attached: false,
          searchHit: false,
          inFlight: false,
        },
        {
          id: "src/nested/app.ts",
          path: "src/nested/app.ts",
          label: "app.ts",
          kind: "file",
          depth: 3,
          expanded: false,
          selected: false,
          focused: false,
          active: true,
          attached: false,
          searchHit: false,
          inFlight: false,
        },
      ],
    },
    store: {},
  };
  harness.store = {
    setActivePath: () => {},
    setAttachedPaths: () => {},
    setViewportRows: () => {},
    setInFlightPaths: () => {},
    move: () => {},
    movePage: () => {},
    moveToStart: () => {},
    moveToEnd: () => {},
    expand: () => {},
    collapse: () => {},
    reveal: () => {},
    toggle: () => {},
    getCursorRow: () => harness.cursorRow,
    createFile: async (value: string) => ({ ok: true, path: value }),
    renamePath: async (from: string, to: string) => {
      harness.renameCalls.push([from, to]);
      return { ok: true, path: to };
    },
    deletePath: async (value: string) => ({ ok: true, path: value }),
  };
  return harness;
});

vi.mock("../../../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 120, rows: 24 }),
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => void>) => {
    explorerHarness.handlers = handlers;
  },
}));

vi.mock("../../../src/tui/components/TextInput.js", async () => {
  const ReactModule = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      explorerHarness.textInputProps.push(props);
      return ReactModule.createElement(ReactModule.Fragment);
    },
  };
});

vi.mock("../../../src/tui/workbench/project-tree/useProjectTree.js", () => ({
  useProjectTree: () => explorerHarness.snapshot,
}));

vi.mock("../../../src/tui/workbench/project-tree/ProjectTreeStore.js", () => ({
  getProjectTreeStore: () => explorerHarness.store,
}));

import { createRoot } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState, type AppState } from "../../../src/tui/state/AppState.js";
import { ProjectExplorer } from "../../../src/tui/workbench/project-tree/ProjectExplorer.js";

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
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 120;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 24;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true;

  return { stdin, stdout };
}

function sleep(ms = 20): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("ProjectExplorer interactions", () => {
  beforeEach(() => {
    explorerHarness.handlers = {};
    explorerHarness.textInputProps = [];
    explorerHarness.renameCalls = [];
  });

  it("updates the active buffer when renaming a directory that contains it", async () => {
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
            workbench: {
              ...getDefaultAppState().workbench,
              focusedPane: "explorer",
              activeSurfaceMode: "preview",
              activeFilePath: "src/nested/app.ts",
              activeFileLine: 12,
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <ProjectExplorer focused={true} width={40} />
        </AppStateProvider>,
      );
      await sleep();

      explorerHarness.handlers["explorer:rename"]?.();
      await sleep();

      const submitRename = explorerHarness.textInputProps.at(-1)?.onSubmit as ((value: string) => void) | undefined;
      expect(submitRename).toEqual(expect.any(Function));
      submitRename?.("lib");
      await sleep();

      expect(explorerHarness.renameCalls).toEqual([["src", "lib"]]);
      expect(changes.at(-1)?.workbench).toMatchObject({
        focusedPane: "explorer",
        activeSurfaceMode: "buffer",
        activeFilePath: "lib/nested/app.ts",
        activeFileLine: 12,
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
