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
    storeCalls: Array<readonly [string, readonly unknown[]]>;
    activePathCalls: Array<string | null>;
    attachedPathCalls: string[][];
    viewportRowsCalls: number[];
    inFlightPathCalls: string[][];
    deferCreate: boolean;
    deferDelete: boolean;
    rejectCreateError: unknown | null;
    rejectRenameError: unknown | null;
    rejectDeleteError: unknown | null;
    createResult: { readonly ok: false; readonly error: string } | null;
    renameResult: { readonly ok: false; readonly error: string } | null;
    deleteResult: { readonly ok: false; readonly error: string } | null;
    pendingCreateResolve: null | ((result: { readonly ok: true; readonly path: string }) => void);
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
    storeCalls: [],
    activePathCalls: [],
    attachedPathCalls: [],
    viewportRowsCalls: [],
    inFlightPathCalls: [],
    deferCreate: false,
    deferDelete: false,
    rejectCreateError: null,
    rejectRenameError: null,
    rejectDeleteError: null,
    createResult: null,
    renameResult: null,
    deleteResult: null,
    pendingCreateResolve: null,
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
      fileCount: 1,
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
    setActivePath: (path: string | null) => {
      harness.activePathCalls.push(path);
    },
    setAttachedPaths: (paths: Iterable<string>) => {
      harness.attachedPathCalls.push([...paths]);
    },
    setViewportRows: (rows: number) => {
      harness.viewportRowsCalls.push(rows);
    },
    setInFlightPaths: (paths: Iterable<string>) => {
      harness.inFlightPathCalls.push([...paths]);
    },
    move: (delta: number) => {
      harness.storeCalls.push(["move", [delta]]);
    },
    movePage: (delta: number) => {
      harness.storeCalls.push(["movePage", [delta]]);
    },
    moveToStart: () => {
      harness.storeCalls.push(["moveToStart", []]);
    },
    moveToEnd: () => {
      harness.storeCalls.push(["moveToEnd", []]);
    },
    expand: () => {
      harness.storeCalls.push(["expand", []]);
    },
    collapse: () => {
      harness.storeCalls.push(["collapse", []]);
    },
    reveal: (path: string | null) => {
      harness.storeCalls.push(["reveal", [path]]);
    },
    toggle: (path: string) => {
      harness.storeCalls.push(["toggle", [path]]);
    },
    getCursorRow: () => harness.cursorRow,
    createFile: async (value: string) => {
      harness.createCalls.push(value);
      if (harness.rejectCreateError) throw harness.rejectCreateError;
      if (harness.deferCreate) {
        return new Promise((resolve) => {
          harness.pendingCreateResolve = resolve;
        });
      }
      if (harness.createResult) return harness.createResult;
      return { ok: true, path: value };
    },
    renamePath: async (from: string, to: string) => {
      harness.renameCalls.push([from, to]);
      if (harness.rejectRenameError) throw harness.rejectRenameError;
      if (harness.renameResult) return harness.renameResult;
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
      if (harness.deleteResult) return harness.deleteResult;
      return { ok: true, path: value };
    },
  };
  return harness;
});

vi.mock("../../../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 120, rows: 24 }),
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useInputCapture: () => {},
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

function directoryRow(path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: path,
    path,
    label: path.split("/").at(-1) ?? path,
    kind: "directory",
    depth: 1,
    expanded: true,
    selected: true,
    focused: true,
    active: false,
    attached: false,
    searchHit: false,
    inFlight: false,
    ...overrides,
  };
}

function fileRow(
  path: string,
  label = path.split("/").at(-1) ?? path,
  depth = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: path,
    path,
    label,
    kind: "file",
    depth,
    expanded: false,
    selected: false,
    focused: false,
    active: false,
    attached: false,
    searchHit: false,
    inFlight: false,
    ...overrides,
  };
}

async function renderExplorer(options: {
  readonly focused?: boolean;
  readonly width?: number;
  readonly workbench?: Partial<NonNullable<AppState["workbench"]>>;
} = {}): Promise<{
  readonly changes: AppState[];
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
  readonly root: Awaited<ReturnType<typeof createRoot>>;
  readonly output: () => string;
}> {
  const changes: AppState[] = [];
  const { stdin, stdout } = createStreams();
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  root.render(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        workbench: {
          ...getDefaultAppState().workbench,
          focusedPane: "explorer",
          ...options.workbench,
        },
      }}
      onChangeAppState={({ newState }) => changes.push(newState)}
    >
      <ProjectExplorer focused={options.focused ?? true} width={options.width ?? 40} />
    </AppStateProvider>,
  );
  await sleep();

  return { changes, stdin, stdout, root, output: () => output };
}

function cleanupExplorer(root: Awaited<ReturnType<typeof createRoot>>, stdin: TestStdin, stdout: PassThrough): void {
  root.unmount();
  stdin.end();
  stdout.end();
}

describe("ProjectExplorer interactions", () => {
  beforeEach(() => {
    explorerHarness.handlers = {};
    explorerHarness.textInputProps = [];
    explorerHarness.createCalls = [];
    explorerHarness.renameCalls = [];
    explorerHarness.deleteCalls = [];
    explorerHarness.storeCalls = [];
    explorerHarness.activePathCalls = [];
    explorerHarness.attachedPathCalls = [];
    explorerHarness.viewportRowsCalls = [];
    explorerHarness.inFlightPathCalls = [];
    explorerHarness.deferCreate = false;
    explorerHarness.deferDelete = false;
    explorerHarness.rejectCreateError = null;
    explorerHarness.rejectRenameError = null;
    explorerHarness.rejectDeleteError = null;
    explorerHarness.createResult = null;
    explorerHarness.renameResult = null;
    explorerHarness.deleteResult = null;
    explorerHarness.pendingCreateResolve = null;
    explorerHarness.pendingDeleteResolve = null;
    explorerHarness.cursorRow = directoryRow("src");
    explorerHarness.snapshot = {
      cwd: "/repo",
      loading: false,
      error: null,
      cursorPath: "src",
      activePath: "src/nested/app.ts",
      expandedPaths: ["src"],
      fileCount: 1,
      rows: [
        directoryRow("src"),
        fileRow("src/nested/app.ts", "app.ts", 3, { active: true }),
      ],
    };
    explorerHarness.logError.mockClear();
  });

  it("marks only composer-selected attachments as attached in the tree store", async () => {
    const { root, stdin, stdout } = await renderExplorer({
      workbench: {
        activeFilePath: "src/app.ts",
        attachments: [{
          id: "file:src/app.ts",
          kind: "file",
          label: "src/app.ts",
          path: "src/app.ts",
        }, {
          id: "file:src/stale.ts",
          kind: "file",
          label: "src/stale.ts",
          path: "src/stale.ts",
        }, {
          id: "task:missing-path",
          kind: "task-error",
          label: "task without path",
        }],
        composerAttachmentIds: ["file:src/app.ts", "task:missing-path"],
      },
    });

    try {
      expect(explorerHarness.activePathCalls.at(-1)).toBe("src/app.ts");
      expect(explorerHarness.attachedPathCalls.at(-1)).toEqual(["src/app.ts"]);
      expect(explorerHarness.viewportRowsCalls.at(-1)).toBe(16);
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it("renders dirty, loading, error, and overflow status from the project tree snapshot", async () => {
    const rows = Array.from({ length: 32 }, (_, index) =>
      fileRow(`src/file-${index}.ts`, `file-${index}.ts`, 1, {
        selected: index === 20,
        focused: index === 20,
        gitState: index === 4 ? "clean" : index === 20 ? "modified" : undefined,
      }),
    );
    explorerHarness.snapshot = {
      cwd: "/repo",
      loading: true,
      error: "tree unavailable",
      cursorPath: "src/file-20.ts",
      activePath: null,
      expandedPaths: ["src"],
      fileCount: rows.length,
      rows,
    };
    const { output, root, stdin, stdout } = await renderExplorer({ width: 48 });

    try {
      await sleep();
      const renderedText = output()
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, " ")
        .replace(/\s+/gu, " ");

      expect(renderedText).toContain("1 changed");
      expect(renderedText).toContain("sync");
      expect(renderedText).toContain("tree unavailable");
      // Scroll-overflow indicators read as a position relative to each end
      // ("N above" / "N below") rather than an ambiguous "N more".
      expect(renderedText).toMatch(/\d+ above/u);
      expect(renderedText).toMatch(/\d+ below/u);
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it("routes explorer navigation keys to the project tree store", async () => {
    const { root, stdin, stdout } = await renderExplorer({
      workbench: {
        activeFilePath: "src/nested/app.ts",
      },
    });

    try {
      explorerHarness.handlers["explorer:up"]?.();
      explorerHarness.handlers["explorer:down"]?.();
      explorerHarness.handlers["explorer:pageUp"]?.();
      explorerHarness.handlers["explorer:pageDown"]?.();
      explorerHarness.handlers["explorer:top"]?.();
      explorerHarness.handlers["explorer:bottom"]?.();
      explorerHarness.handlers["explorer:expand"]?.();
      explorerHarness.handlers["explorer:collapse"]?.();
      explorerHarness.handlers["explorer:revealActive"]?.();
      explorerHarness.handlers["explorer:open"]?.();

      expect(explorerHarness.storeCalls).toEqual([
        ["move", [-1]],
        ["move", [1]],
        ["movePage", [-1]],
        ["movePage", [1]],
        ["moveToStart", []],
        ["moveToEnd", []],
        ["expand", []],
        ["collapse", []],
        ["reveal", ["src/nested/app.ts"]],
        ["toggle", ["src"]],
      ]);
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it("returns keyboard focus to the composer on explorer:backToComposer", async () => {
    const { changes, root, stdin, stdout } = await renderExplorer({
      workbench: {
        focusedPane: "explorer",
      },
    });

    try {
      explorerHarness.handlers["explorer:backToComposer"]?.();
      await sleep();

      expect(changes.at(-1)?.workbench).toMatchObject({
        focusedPane: "composer",
      });
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it.each([
    ["explorer:open", true],
    ["explorer:openKeepFocus", false],
    ["explorer:edit", true],
    ["explorer:editKeepFocus", false],
  ] as const)("opens file rows from %s with the expected focus behavior", async (handlerName, shouldFocusSurface) => {
    explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, { selected: true, focused: true });
    const { changes, root, stdin, stdout } = await renderExplorer();

    try {
      explorerHarness.handlers[handlerName]?.();
      await sleep();

      expect(changes.at(-1)?.workbench).toMatchObject({
        activeSurfaceMode: "buffer",
        activeFilePath: "src/nested/app.ts",
        focusedPane: shouldFocusSurface ? "surface" : "explorer",
      });
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it("attaches the selected file row from the explorer", async () => {
    explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, { selected: true, focused: true });
    const { changes, root, stdin, stdout } = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:attach"]?.();
      await sleep();

      expect(changes.at(-1)?.workbench).toMatchObject({
        attachments: [{
          id: "file:src/nested/app.ts",
          kind: "file",
          path: "src/nested/app.ts",
          label: "src/nested/app.ts",
        }],
        composerAttachmentIds: ["file:src/nested/app.ts"],
      });
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it("ignores file-only commands when the cursor is not on a file row", async () => {
    const { changes, root, stdin, stdout } = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:openKeepFocus"]?.();
      explorerHarness.handlers["explorer:edit"]?.();
      explorerHarness.handlers["explorer:editKeepFocus"]?.();
      explorerHarness.handlers["explorer:attach"]?.();
      await sleep();

      expect(changes).toHaveLength(0);
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it("keeps a busy create prompt from submitting duplicate mutations", async () => {
    explorerHarness.deferCreate = true;
    const { root, stdin, stdout } = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();

      const submitCreate = explorerHarness.textInputProps.at(-1)?.onSubmit as ((value: string) => void) | undefined;
      submitCreate?.("src/new.ts");
      await sleep();

      const submitWhileBusy = explorerHarness.textInputProps.at(-1)?.onSubmit as ((value: string) => void) | undefined;
      submitWhileBusy?.("src/duplicate.ts");
      await sleep();

      expect(explorerHarness.createCalls).toEqual(["src/new.ts"]);

      explorerHarness.pendingCreateResolve?.({ ok: true, path: "src/new.ts" });
      await sleep();
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it("updates and cancels explorer file-action prompts through TextInput callbacks", async () => {
    const { root, stdin, stdout } = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();

      const onChange = explorerHarness.textInputProps.at(-1)?.onChange as ((value: string) => void) | undefined;
      const onExit = explorerHarness.textInputProps.at(-1)?.onExit as (() => void) | undefined;
      onChange?.("src/typed.ts");
      await sleep();

      expect(explorerHarness.textInputProps.at(-1)?.value).toBe("src/typed.ts");

      onExit?.();
      await sleep();
      onChange?.("src/after-close.ts");
      await sleep();

      expect(explorerHarness.handlers["explorer:addFile"]).toEqual(expect.any(Function));
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it("uses file parents and empty selections as add-file prompt defaults", async () => {
    explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, { selected: true, focused: true });
    const fileSelection = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();

      expect(explorerHarness.textInputProps.at(-1)?.value).toBe("src/nested/");
    } finally {
      cleanupExplorer(fileSelection.root, fileSelection.stdin, fileSelection.stdout);
    }

    explorerHarness.textInputProps = [];
    explorerHarness.cursorRow = fileRow("README.md", "README.md", 1, { selected: true, focused: true });
    const rootFileSelection = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();

      expect(explorerHarness.textInputProps.at(-1)?.value).toBe("");
    } finally {
      cleanupExplorer(rootFileSelection.root, rootFileSelection.stdin, rootFileSelection.stdout);
    }

    explorerHarness.textInputProps = [];
    explorerHarness.cursorRow = null;
    const emptySelection = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();

      expect(explorerHarness.textInputProps.at(-1)?.value).toBe("");
    } finally {
      cleanupExplorer(emptySelection.root, emptySelection.stdin, emptySelection.stdout);
    }
  });

  it("ignores rename and delete commands for non-mutable tree rows", async () => {
    explorerHarness.cursorRow = {
      id: "loading",
      path: "loading",
      label: "loading",
      kind: "loading",
      depth: 1,
      expanded: false,
      selected: true,
      focused: true,
      active: false,
      attached: false,
      searchHit: false,
      inFlight: false,
    };
    const { root, stdin, stdout } = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:rename"]?.();
      await sleep();
      explorerHarness.handlers["explorer:delete"]?.();
      await sleep();
      explorerHarness.handlers["explorer:open"]?.();
      await sleep();

      expect(explorerHarness.textInputProps).toHaveLength(0);
      expect(explorerHarness.storeCalls).toHaveLength(0);
      expect(explorerHarness.handlers["confirm:yes"]).toBeUndefined();
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it("keeps file-action prompts open when store mutations return validation errors", async () => {
    explorerHarness.createResult = { ok: false, error: "create validation failed" };
    const createSelection = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();
      const submitCreate = explorerHarness.textInputProps.at(-1)?.onSubmit as ((value: string) => void) | undefined;
      submitCreate?.("src/new.ts");
      await sleep();

      expect(explorerHarness.createCalls).toEqual(["src/new.ts"]);
      expect(explorerHarness.textInputProps.at(-1)?.focus).toBe(true);
    } finally {
      cleanupExplorer(createSelection.root, createSelection.stdin, createSelection.stdout);
    }

    explorerHarness.textInputProps = [];
    explorerHarness.createResult = null;
    explorerHarness.renameResult = { ok: false, error: "rename validation failed" };
    explorerHarness.cursorRow = directoryRow("src");
    const renameSelection = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:rename"]?.();
      await sleep();
      const submitRename = explorerHarness.textInputProps.at(-1)?.onSubmit as ((value: string) => void) | undefined;
      submitRename?.("lib");
      await sleep();

      expect(explorerHarness.renameCalls).toEqual([["src", "lib"]]);
      expect(explorerHarness.textInputProps.at(-1)?.focus).toBe(true);
    } finally {
      cleanupExplorer(renameSelection.root, renameSelection.stdin, renameSelection.stdout);
    }

    explorerHarness.renameResult = null;
    explorerHarness.deleteResult = { ok: false, error: "delete validation failed" };
    explorerHarness.cursorRow = directoryRow("src");
    const deleteSelection = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:delete"]?.();
      await sleep();
      explorerHarness.handlers["confirm:yes"]?.();
      await sleep();

      expect(explorerHarness.deleteCalls).toEqual(["src"]);
      expect(explorerHarness.handlers["confirm:yes"]).toEqual(expect.any(Function));
    } finally {
      cleanupExplorer(deleteSelection.root, deleteSelection.stdin, deleteSelection.stdout);
    }
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

      explorerHarness.handlers["confirm:yes"]?.();
      await sleep();
      expect(explorerHarness.deleteCalls).toEqual(["src"]);

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

  it("handles non-Error create rejections without closing the prompt", async () => {
    explorerHarness.rejectCreateError = "permission denied";
    const { root, stdin, stdout } = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();

      const submitCreate = explorerHarness.textInputProps.at(-1)?.onSubmit as ((value: string) => void) | undefined;
      submitCreate?.("src/new.ts");
      await sleep();

      expect(explorerHarness.logError).toHaveBeenCalledWith("permission denied");
      expect(explorerHarness.textInputProps.at(-1)?.focus).toBe(true);
    } finally {
      cleanupExplorer(root, stdin, stdout);
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
