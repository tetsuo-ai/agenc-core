import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const explorerHarness = vi.hoisted(() => {
  const harness: {
    handlers: Record<string, () => void>;
    textInputProps: Array<Record<string, unknown>>;
    createCalls: string[];
    renameCalls: Array<readonly [string, string]>;
    deleteCalls: string[];
    deferDelete: boolean;
    rejectCreateError: Error | null;
    rejectRenameError: Error | null;
    rejectDeleteError: Error | null;
    pendingDeleteResolve: null | ((result: { readonly ok: true; readonly path: string }) => void);
    logError: ReturnType<typeof vi.fn>;
    cursorRow: Record<string, unknown> | null;
    snapshot: Record<string, unknown>;
    store: Record<string, unknown>;
  } = {
    handlers: {},
    textInputProps: [],
    createCalls: [],
    renameCalls: [],
    deleteCalls: [],
    deferDelete: false,
    rejectCreateError: null,
    rejectRenameError: null,
    rejectDeleteError: null,
    pendingDeleteResolve: null,
    logError: vi.fn(),
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
    createFile: async (value: string) => {
      harness.createCalls.push(value);
      if (harness.rejectCreateError) throw harness.rejectCreateError;
      return { ok: true, path: value };
    },
    renamePath: async (from: string, to: string) => {
      harness.renameCalls.push([from, to]);
      if (harness.rejectRenameError) throw harness.rejectRenameError;
      return { ok: true, path: to };
    },
    deletePath: async (value: string) => {
      harness.deleteCalls.push(value);
      if (harness.rejectDeleteError) throw harness.rejectDeleteError;
      if (harness.deferDelete) {
        return new Promise((resolve) => {
          harness.pendingDeleteResolve = resolve;
        });
      }
      return { ok: true, path: value };
    },
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

vi.mock("../../../src/utils/log.js", () => ({
  logError: explorerHarness.logError,
}));

import { createRoot } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState, type AppState, useSetAppState } from "../../../src/tui/state/AppState.js";
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
    explorerHarness.createCalls = [];
    explorerHarness.renameCalls = [];
    explorerHarness.deleteCalls = [];
    explorerHarness.deferDelete = false;
    explorerHarness.rejectCreateError = null;
    explorerHarness.rejectRenameError = null;
    explorerHarness.rejectDeleteError = null;
    explorerHarness.pendingDeleteResolve = null;
    explorerHarness.logError.mockClear();
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
              attachments: [{
                id: "file-range:src/nested/app.ts:12-15",
                kind: "file-range",
                label: "src/nested/app.ts:12-15",
                path: "src/nested/app.ts",
                line: 12,
                endLine: 15,
              }],
              composerAttachmentIds: ["file-range:src/nested/app.ts:12-15"],
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
      submitRename?.("lib/");
      await sleep();

      expect(explorerHarness.renameCalls).toEqual([["src", "lib/"]]);
      expect(changes.at(-1)?.workbench).toMatchObject({
        focusedPane: "explorer",
        activeSurfaceMode: "buffer",
        activeFilePath: "lib/nested/app.ts",
        activeFileLine: 12,
        attachments: [{
          id: "file-range:lib/nested/app.ts:12-15",
          kind: "file-range",
          label: "lib/nested/app.ts:12-15",
          path: "lib/nested/app.ts",
          line: 12,
          endLine: 15,
        }],
        composerAttachmentIds: ["file-range:lib/nested/app.ts:12-15"],
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("does not reopen an unrelated active file when renaming another path", async () => {
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
              activeFilePath: "other.ts",
              activeFileLine: 5,
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
        activeSurfaceMode: "preview",
        activeFilePath: "other.ts",
        activeFileLine: 5,
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("clears active and attached references when deleting a directory that contains them", async () => {
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
              activeSurfaceMode: "buffer",
              activeFilePath: "src/nested/app.ts",
              activeFileLine: 12,
              attachments: [
                {
                  id: "file-range:src/nested/app.ts:12-15",
                  kind: "file-range",
                  label: "src/nested/app.ts:12-15",
                  path: "src/nested/app.ts",
                  line: 12,
                  endLine: 15,
                },
                {
                  id: "file:src-old/app.ts",
                  kind: "file",
                  label: "src-old/app.ts",
                  path: "src-old/app.ts",
                },
              ],
              composerAttachmentIds: [
                "file-range:src/nested/app.ts:12-15",
                "file:src-old/app.ts",
              ],
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <ProjectExplorer focused={true} width={40} />
        </AppStateProvider>,
      );
      await sleep();

      explorerHarness.handlers["explorer:delete"]?.();
      await sleep();

      explorerHarness.handlers["confirm:yes"]?.();
      await sleep();

      expect(explorerHarness.deleteCalls).toEqual(["src"]);
      expect(changes.at(-1)?.workbench).toMatchObject({
        focusedPane: "surface",
        activeSurfaceMode: "transcript",
        activeFilePath: null,
        activeFileLine: null,
        attachments: [{
          id: "file:src-old/app.ts",
          kind: "file",
          label: "src-old/app.ts",
          path: "src-old/app.ts",
        }],
        composerAttachmentIds: ["file:src-old/app.ts"],
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("does not close a newer active file when delete finishes after navigation moved away", async () => {
    explorerHarness.deferDelete = true;
    const changes: AppState[] = [];
    let setWorkbench: ((next: Partial<NonNullable<AppState["workbench"]>>) => void) | null = null;
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
              activeSurfaceMode: "buffer",
              activeFilePath: "src/nested/app.ts",
              activeFileLine: 12,
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <WorkbenchStateSetter onReady={(setter) => { setWorkbench = setter; }} />
          <ProjectExplorer focused={true} width={40} />
        </AppStateProvider>,
      );
      await sleep();

      explorerHarness.handlers["explorer:delete"]?.();
      await sleep();

      explorerHarness.handlers["confirm:yes"]?.();
      await sleep();

      setWorkbench?.({
        activeSurfaceMode: "preview",
        activeFilePath: "other.ts",
        activeFileLine: 5,
      });
      await sleep();

      explorerHarness.pendingDeleteResolve?.({ ok: true, path: "src" });
      await sleep();

      expect(explorerHarness.deleteCalls).toEqual(["src"]);
      expect(changes.at(-1)?.workbench).toMatchObject({
        activeSurfaceMode: "preview",
        activeFilePath: "other.ts",
        activeFileLine: 5,
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("logs rejected create actions and restores the prompt for retry", async () => {
    const createError = new Error("create failed");
    explorerHarness.rejectCreateError = createError;
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
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <ProjectExplorer focused={true} width={40} />
        </AppStateProvider>,
      );
      await sleep();

      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();

      const submitCreate = explorerHarness.textInputProps.at(-1)?.onSubmit as ((value: string) => void) | undefined;
      expect(submitCreate).toEqual(expect.any(Function));
      submitCreate?.("src/new.ts");
      await sleep();

      expect(explorerHarness.logError).toHaveBeenCalledWith(createError);
      expect(explorerHarness.textInputProps.at(-1)?.focus).toBe(true);

      explorerHarness.rejectCreateError = null;
      const retryCreate = explorerHarness.textInputProps.at(-1)?.onSubmit as ((value: string) => void) | undefined;
      retryCreate?.("src/new.ts");
      await sleep();

      expect(explorerHarness.createCalls).toEqual(["src/new.ts", "src/new.ts"]);
      expect(changes.at(-1)?.workbench).toMatchObject({
        activeSurfaceMode: "buffer",
        activeFilePath: "src/new.ts",
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("logs rejected rename actions and restores the prompt for retry", async () => {
    const renameError = new Error("rename failed");
    explorerHarness.rejectRenameError = renameError;
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
              activeSurfaceMode: "buffer",
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
      submitRename?.("lib/");
      await sleep();

      expect(explorerHarness.logError).toHaveBeenCalledWith(renameError);
      expect(explorerHarness.textInputProps.at(-1)?.focus).toBe(true);

      explorerHarness.rejectRenameError = null;
      const retryRename = explorerHarness.textInputProps.at(-1)?.onSubmit as ((value: string) => void) | undefined;
      retryRename?.("lib/");
      await sleep();

      expect(explorerHarness.renameCalls).toEqual([["src", "lib/"], ["src", "lib/"]]);
      expect(changes.at(-1)?.workbench).toMatchObject({
        activeSurfaceMode: "buffer",
        activeFilePath: "lib/nested/app.ts",
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("logs rejected delete actions and restores the confirmation for retry", async () => {
    const deleteError = new Error("delete failed");
    explorerHarness.rejectDeleteError = deleteError;
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
              activeSurfaceMode: "buffer",
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

      explorerHarness.handlers["explorer:delete"]?.();
      await sleep();

      explorerHarness.handlers["confirm:yes"]?.();
      await sleep();

      expect(explorerHarness.logError).toHaveBeenCalledWith(deleteError);

      explorerHarness.rejectDeleteError = null;
      explorerHarness.handlers["confirm:yes"]?.();
      await sleep();

      expect(explorerHarness.deleteCalls).toEqual(["src", "src"]);
      expect(changes.at(-1)?.workbench).toMatchObject({
        activeSurfaceMode: "transcript",
        activeFilePath: null,
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});

function WorkbenchStateSetter({
  onReady,
}: {
  readonly onReady: (setWorkbench: (next: Partial<NonNullable<AppState["workbench"]>>) => void) => void;
}): null {
  const setAppState = useSetAppState();
  React.useEffect(() => {
    onReady((next) => {
      setAppState((state) => ({
        ...state,
        workbench: {
          ...getDefaultAppState().workbench,
          ...state.workbench,
          ...next,
        },
      }));
    });
  }, [onReady, setAppState]);
  return null;
}
