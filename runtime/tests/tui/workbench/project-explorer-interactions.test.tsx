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
    synchronizeRenameCalls: Array<readonly [string, string]>;
    synchronizeDeleteCalls: string[];
    synchronizeRenameResult: {
      readonly ok: false;
      readonly reason: string;
    } | null;
    synchronizeDeleteResult: {
      readonly ok: false;
      readonly reason: string;
    } | null;
    mutationSequence: string[];
    pathMutationLeaseCount: number;
    inFlightWithin: boolean;
    synchronizeDeleteSideEffect: (() => void) | null;
    topologyEnabled: boolean;
    topologyReserveError: unknown | null;
    topologyReserveCalls: Array<{
      readonly workspaceRoot: string;
      readonly targets: readonly Record<string, unknown>[];
    }>;
    topologyCompleteCalls: Array<"applied" | "unknown_outcome">;
    topologyReleaseCalls: number;
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
    rollbackRenameResult: { readonly ok: false; readonly error: string } | null;
    deleteResult: { readonly ok: false; readonly error: string } | null;
    pendingCreateResolve:
      null | ((result: { readonly ok: true; readonly path: string }) => void);
    pendingDeleteResolve:
      null | ((result: { readonly ok: true; readonly path: string }) => void);
    bufferSnapshot: {
      readonly dirty: boolean;
      readonly filePath: string | null;
      readonly provider?: { readonly kind: string };
      readonly providerStatus?: string;
      readonly workspaceAuthorityRequired?: boolean;
      readonly buffers: Array<{
        readonly handle: number;
        readonly name: string;
        readonly filePath: string | null;
        readonly absolutePath: string | null;
        readonly listed: boolean;
        readonly loaded: boolean;
        readonly modified: boolean;
        readonly current: boolean;
        readonly bufferType: string;
        readonly modifiable: boolean;
        readonly readOnly: boolean;
        readonly saveable: boolean;
      }>;
    };
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
    synchronizeRenameCalls: [],
    synchronizeDeleteCalls: [],
    synchronizeRenameResult: null,
    synchronizeDeleteResult: null,
    mutationSequence: [],
    pathMutationLeaseCount: 0,
    inFlightWithin: false,
    synchronizeDeleteSideEffect: null,
    topologyEnabled: false,
    topologyReserveError: null,
    topologyReserveCalls: [],
    topologyCompleteCalls: [],
    topologyReleaseCalls: 0,
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
    rollbackRenameResult: null,
    deleteResult: null,
    pendingCreateResolve: null,
    pendingDeleteResolve: null,
    bufferSnapshot: {
      dirty: false,
      filePath: null,
      buffers: [],
    },
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
    getFilePaths: () =>
      ((harness.snapshot.rows ?? []) as Array<Record<string, unknown>>)
        .filter((row) => row.kind === "file")
        .map((row) => String(row.path)),
    hasInFlightPathWithin: () => harness.inFlightWithin,
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
    createFile: async (
      value: string,
      options?: { readonly beforeCommit?: () => string | null },
    ) => {
      harness.mutationSequence.push(`disk:create:${value}`);
      harness.createCalls.push(value);
      if (harness.rejectCreateError) throw harness.rejectCreateError;
      const refusal = options?.beforeCommit?.();
      if (refusal) return { ok: false, error: refusal };
      if (harness.deferCreate) {
        return new Promise((resolve) => {
          harness.pendingCreateResolve = resolve;
        });
      }
      if (harness.createResult) return harness.createResult;
      return { ok: true, path: value };
    },
    renamePath: async (from: string, to: string) => {
      harness.mutationSequence.push(`disk:rename:${from}:${to}`);
      harness.renameCalls.push([from, to]);
      if (harness.rejectRenameError) throw harness.rejectRenameError;
      if (harness.rollbackRenameResult && from === "lib" && to === "src") {
        return harness.rollbackRenameResult;
      }
      if (harness.renameResult) return harness.renameResult;
      return { ok: true, path: to };
    },
    deletePath: async (value: string) => {
      harness.mutationSequence.push(`disk:delete:${value}`);
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

vi.mock(
  "../../../src/tui/workbench/buffer/providers/BufferProviderController.js",
  () => ({
    getWorkbenchBufferProviderController: () => ({
      getSnapshot: () => explorerHarness.bufferSnapshot,
      beginProjectPathMutation: () => {
        if (explorerHarness.pathMutationLeaseCount !== 0) return false;
        explorerHarness.pathMutationLeaseCount = 1;
        explorerHarness.mutationSequence.push("nvim:lock");
        return true;
      },
      endProjectPathMutation: () => {
        explorerHarness.pathMutationLeaseCount = 0;
        explorerHarness.mutationSequence.push("nvim:unlock");
      },
      synchronizePathRename: async (fromPath: string, toPath: string) => {
        explorerHarness.mutationSequence.push(
          `nvim:rename:${fromPath}:${toPath}`,
        );
        explorerHarness.synchronizeRenameCalls.push([fromPath, toPath]);
        return (
          explorerHarness.synchronizeRenameResult ?? {
            ok: true as const,
            affectedBufferHandles: [],
          }
        );
      },
      synchronizePathDelete: async (path: string) => {
        explorerHarness.mutationSequence.push(`nvim:delete:${path}`);
        explorerHarness.synchronizeDeleteCalls.push(path);
        explorerHarness.synchronizeDeleteSideEffect?.();
        return (
          explorerHarness.synchronizeDeleteResult ?? {
            ok: true as const,
            affectedBufferHandles: [],
          }
        );
      },
    }),
  }),
);

vi.mock("../../../src/tui/workbench/workspaceEditorLeaseSync.js", () => ({
  bufferSnapshotRequiresWorkspaceEditorAuthority: (snapshot: {
    readonly provider?: { readonly kind: string };
    readonly workspaceAuthorityRequired?: boolean;
  }) =>
    snapshot.provider?.kind === "neovim" &&
    snapshot.workspaceAuthorityRequired === true,
  beginWorkspaceEditorTopologyMutation: async (
    workspaceRoot: string,
    targets: readonly Record<string, unknown>[],
  ) => {
    if (!explorerHarness.topologyEnabled) return null;
    explorerHarness.mutationSequence.push("daemon:reserve");
    explorerHarness.topologyReserveCalls.push({ workspaceRoot, targets });
    if (explorerHarness.topologyReserveError !== null) {
      throw explorerHarness.topologyReserveError;
    }
    return {
      tokenId: "topology-test",
      complete: async (status: "applied" | "unknown_outcome") => {
        explorerHarness.mutationSequence.push(`daemon:complete:${status}`);
        explorerHarness.topologyCompleteCalls.push(status);
      },
      release: async () => {
        explorerHarness.mutationSequence.push("daemon:release");
        explorerHarness.topologyReleaseCalls += 1;
      },
    };
  },
}));

import { createRoot } from "../../../src/tui/ink.js";
import {
  AppStateProvider,
  getDefaultAppState,
  type AppState,
  useSetAppState,
} from "../../../src/tui/state/AppState.js";
import { ProjectExplorer } from "../../../src/tui/workbench/project-tree/ProjectExplorer.js";
import { useWorkbenchDispatch } from "../../../src/tui/workbench/state.js";
import type { WorkbenchCommand } from "../../../src/tui/workbench/types.js";

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
  (
    stdout as unknown as { columns: number; rows: number; isTTY: boolean }
  ).columns = 120;
  (
    stdout as unknown as { columns: number; rows: number; isTTY: boolean }
  ).rows = 24;
  (
    stdout as unknown as { columns: number; rows: number; isTTY: boolean }
  ).isTTY = true;

  return { stdin, stdout };
}

function sleep(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function directoryRow(
  path: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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

async function renderExplorer(
  options: {
    readonly focused?: boolean;
    readonly width?: number;
    readonly workbench?: Partial<NonNullable<AppState["workbench"]>>;
  } = {},
): Promise<{
  readonly changes: AppState[];
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
  readonly root: Awaited<ReturnType<typeof createRoot>>;
  readonly output: () => string;
  readonly dispatch: (command: WorkbenchCommand) => void;
}> {
  const changes: AppState[] = [];
  const { stdin, stdout } = createStreams();
  let workbenchDispatch: ((command: WorkbenchCommand) => void) | null = null;
  const captureDispatch = (
    dispatch: (command: WorkbenchCommand) => void,
  ): void => {
    workbenchDispatch = dispatch;
  };
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
      <WorkbenchDispatchProbe onReady={captureDispatch} />
      <ProjectExplorer
        focused={options.focused ?? true}
        width={options.width ?? 40}
      />
    </AppStateProvider>,
  );
  await sleep();

  return {
    changes,
    stdin,
    stdout,
    root,
    output: () => output,
    dispatch: (command) => {
      if (workbenchDispatch === null) {
        throw new Error("Workbench dispatch probe was not ready");
      }
      workbenchDispatch(command);
    },
  };
}

function cleanupExplorer(
  root: Awaited<ReturnType<typeof createRoot>>,
  stdin: TestStdin,
  stdout: PassThrough,
): void {
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
    explorerHarness.synchronizeRenameCalls = [];
    explorerHarness.synchronizeDeleteCalls = [];
    explorerHarness.synchronizeRenameResult = null;
    explorerHarness.synchronizeDeleteResult = null;
    explorerHarness.mutationSequence = [];
    explorerHarness.pathMutationLeaseCount = 0;
    explorerHarness.inFlightWithin = false;
    explorerHarness.synchronizeDeleteSideEffect = null;
    explorerHarness.topologyEnabled = false;
    explorerHarness.topologyReserveError = null;
    explorerHarness.topologyReserveCalls = [];
    explorerHarness.topologyCompleteCalls = [];
    explorerHarness.topologyReleaseCalls = 0;
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
    explorerHarness.rollbackRenameResult = null;
    explorerHarness.deleteResult = null;
    explorerHarness.pendingCreateResolve = null;
    explorerHarness.pendingDeleteResolve = null;
    explorerHarness.bufferSnapshot = {
      dirty: false,
      filePath: null,
      buffers: [],
    };
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
        attachments: [
          {
            id: "file:src/app.ts",
            kind: "file",
            label: "src/app.ts",
            path: "src/app.ts",
          },
          {
            id: "file:src/stale.ts",
            kind: "file",
            label: "src/stale.ts",
            path: "src/stale.ts",
          },
          {
            id: "task:missing-path",
            kind: "task-error",
            label: "task without path",
          },
        ],
        composerAttachmentIds: ["file:src/app.ts", "task:missing-path"],
      },
    });

    try {
      expect(explorerHarness.activePathCalls.at(-1)).toBe("src/app.ts");
      expect(explorerHarness.attachedPathCalls.at(-1)).toEqual(["src/app.ts"]);
      expect(explorerHarness.viewportRowsCalls.at(-1)).toBe(12);
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
  ] as const)(
    "opens file rows from %s with the expected focus behavior",
    async (handlerName, shouldFocusSurface) => {
      explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, {
        selected: true,
        focused: true,
      });
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
    },
  );

  it("attaches the selected file row from the explorer", async () => {
    explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, {
      selected: true,
      focused: true,
    });
    const { changes, root, stdin, stdout } = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:attach"]?.();
      await sleep();

      expect(changes.at(-1)?.workbench).toMatchObject({
        attachments: [
          {
            id: "file:src/nested/app.ts",
            kind: "file",
            path: "src/nested/app.ts",
            label: "src/nested/app.ts",
          },
        ],
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

      const submitCreate = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
      submitCreate?.("src/new.ts");
      await sleep();

      const submitWhileBusy = explorerHarness.textInputProps.at(-1)
        ?.onSubmit as ((value: string) => void) | undefined;
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

      const onChange = explorerHarness.textInputProps.at(-1)?.onChange as
        ((value: string) => void) | undefined;
      const onExit = explorerHarness.textInputProps.at(-1)?.onExit as
        (() => void) | undefined;
      onChange?.("src/typed.ts");
      await sleep();

      expect(explorerHarness.textInputProps.at(-1)?.value).toBe("src/typed.ts");

      onExit?.();
      await sleep();
      onChange?.("src/after-close.ts");
      await sleep();

      expect(explorerHarness.handlers["explorer:addFile"]).toEqual(
        expect.any(Function),
      );
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it("uses file parents and empty selections as add-file prompt defaults", async () => {
    explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, {
      selected: true,
      focused: true,
    });
    const fileSelection = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();

      expect(explorerHarness.textInputProps.at(-1)?.value).toBe("src/nested/");
    } finally {
      cleanupExplorer(
        fileSelection.root,
        fileSelection.stdin,
        fileSelection.stdout,
      );
    }

    explorerHarness.textInputProps = [];
    explorerHarness.cursorRow = fileRow("README.md", "README.md", 1, {
      selected: true,
      focused: true,
    });
    const rootFileSelection = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();

      expect(explorerHarness.textInputProps.at(-1)?.value).toBe("");
    } finally {
      cleanupExplorer(
        rootFileSelection.root,
        rootFileSelection.stdin,
        rootFileSelection.stdout,
      );
    }

    explorerHarness.textInputProps = [];
    explorerHarness.cursorRow = null;
    const emptySelection = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();

      expect(explorerHarness.textInputProps.at(-1)?.value).toBe("");
    } finally {
      cleanupExplorer(
        emptySelection.root,
        emptySelection.stdin,
        emptySelection.stdout,
      );
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
    explorerHarness.createResult = {
      ok: false,
      error: "create validation failed",
    };
    const createSelection = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();
      const submitCreate = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
      submitCreate?.("src/new.ts");
      await sleep();

      expect(explorerHarness.createCalls).toEqual(["src/new.ts"]);
      expect(explorerHarness.textInputProps.at(-1)?.focus).toBe(true);
    } finally {
      cleanupExplorer(
        createSelection.root,
        createSelection.stdin,
        createSelection.stdout,
      );
    }

    explorerHarness.textInputProps = [];
    explorerHarness.createResult = null;
    explorerHarness.renameResult = {
      ok: false,
      error: "rename validation failed",
    };
    explorerHarness.cursorRow = directoryRow("src");
    const renameSelection = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:rename"]?.();
      await sleep();
      const submitRename = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
      submitRename?.("lib");
      await sleep();

      expect(explorerHarness.renameCalls).toEqual([["src", "lib"]]);
      expect(explorerHarness.textInputProps.at(-1)?.focus).toBe(true);
    } finally {
      cleanupExplorer(
        renameSelection.root,
        renameSelection.stdin,
        renameSelection.stdout,
      );
    }

    explorerHarness.renameResult = null;
    explorerHarness.deleteResult = {
      ok: false,
      error: "delete validation failed",
    };
    explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, {
      selected: true,
      focused: true,
    });
    const deleteSelection = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:delete"]?.();
      await sleep();
      explorerHarness.handlers["confirm:yes"]?.();
      await sleep();

      expect(explorerHarness.deleteCalls).toEqual(["src/nested/app.ts"]);
      expect(explorerHarness.handlers["confirm:yes"]).toEqual(
        expect.any(Function),
      );
    } finally {
      cleanupExplorer(
        deleteSelection.root,
        deleteSelection.stdin,
        deleteSelection.stdout,
      );
    }
  });

  it("runs directory deletion through Editor synchronization and the topology fence", async () => {
    explorerHarness.topologyEnabled = true;
    const { output, root, stdin, stdout } = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:delete"]?.();
      await sleep();
      explorerHarness.handlers["confirm:yes"]?.();
      await sleep();

      expect(explorerHarness.deleteCalls).toEqual(["src"]);
      expect(explorerHarness.synchronizeDeleteCalls).toEqual(["src"]);
      expect(explorerHarness.topologyReserveCalls).toHaveLength(1);
      expect(explorerHarness.mutationSequence).toEqual([
        "nvim:lock",
        "daemon:reserve",
        "nvim:delete:src",
        "disk:delete:src",
        "daemon:complete:applied",
        "nvim:unlock",
      ]);
      expect(output()).not.toContain("identity-bound");
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it("holds the daemon Editor topology fence across Project Explorer create", async () => {
    explorerHarness.topologyEnabled = true;
    explorerHarness.bufferSnapshot = {
      dirty: false,
      filePath: null,
      provider: { kind: "neovim" },
      providerStatus: "ready",
      buffers: [],
    };
    const { changes, root, stdin, stdout } = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();
      const submitCreate = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
      submitCreate?.("src/new.ts");
      await sleep();

      expect(explorerHarness.topologyReserveCalls).toEqual([
        {
          workspaceRoot: "/repo",
          targets: [
            {
              path: "src/new.ts",
              includeDescendants: false,
              allowOwnedClean: false,
            },
          ],
        },
      ]);
      expect(explorerHarness.mutationSequence).toEqual([
        "nvim:lock",
        "daemon:reserve",
        "disk:create:src/new.ts",
        "daemon:complete:applied",
        "nvim:unlock",
      ]);
      expect(explorerHarness.topologyCompleteCalls).toEqual(["applied"]);
      expect(changes.at(-1)?.workbench).toMatchObject({
        activeFilePath: "src/new.ts",
        activeSurfaceMode: "buffer",
      });
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it.each(["loaded", "quarantined"] as const)(
    "does not create a path rejected by %s Editor authority",
    async (authority) => {
      const reservationFailure = new Error(
        `${authority} Editor path blocks create`,
      );
      explorerHarness.topologyEnabled = true;
      explorerHarness.topologyReserveError = reservationFailure;
      explorerHarness.bufferSnapshot = {
        dirty: authority === "loaded",
        filePath: "src/new.ts",
        provider: { kind: "neovim" },
        providerStatus: "ready",
        buffers: [
          providerBuffer("src/new.ts", {
            current: true,
            modified: authority === "loaded",
          }),
        ],
      };
      const { root, stdin, stdout } = await renderExplorer();

      try {
        explorerHarness.handlers["explorer:addFile"]?.();
        await sleep();
        const submitCreate = explorerHarness.textInputProps.at(-1)?.onSubmit as
          ((value: string) => void) | undefined;
        submitCreate?.("src/new.ts");
        await sleep();

        expect(explorerHarness.mutationSequence).toEqual([
          "nvim:lock",
          "daemon:reserve",
          "nvim:unlock",
        ]);
        expect(explorerHarness.createCalls).toEqual([]);
        expect(explorerHarness.topologyCompleteCalls).toEqual([]);
        expect(explorerHarness.topologyReleaseCalls).toBe(0);
        expect(explorerHarness.logError).toHaveBeenCalledWith(
          reservationFailure,
        );
      } finally {
        cleanupExplorer(root, stdin, stdout);
      }
    },
  );

  it.each(["create", "rename", "delete"] as const)(
    "fails closed for Project Explorer %s while the Neovim provider is in error",
    async (mutation) => {
      explorerHarness.bufferSnapshot = {
        dirty: false,
        filePath: "src/nested/app.ts",
        provider: { kind: "neovim" },
        providerStatus: "error",
        workspaceAuthorityRequired: true,
        buffers: [
          providerBuffer("src/nested/app.ts", {
            current: true,
            modified: false,
          }),
        ],
      };
      if (mutation === "delete") {
        explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, {
          selected: true,
          focused: true,
        });
      }
      const { root, stdin, stdout } = await renderExplorer();

      try {
        if (mutation === "create") {
          explorerHarness.handlers["explorer:addFile"]?.();
          await sleep();
          const submit = explorerHarness.textInputProps.at(-1)?.onSubmit as
            ((value: string) => void) | undefined;
          submit?.("src/new.ts");
        } else if (mutation === "rename") {
          explorerHarness.handlers["explorer:rename"]?.();
          await sleep();
          const submit = explorerHarness.textInputProps.at(-1)?.onSubmit as
            ((value: string) => void) | undefined;
          submit?.("lib");
        } else {
          explorerHarness.handlers["explorer:delete"]?.();
          await sleep();
          explorerHarness.handlers["confirm:yes"]?.();
        }
        await sleep();

        expect(explorerHarness.createCalls).toEqual([]);
        expect(explorerHarness.renameCalls).toEqual([]);
        expect(explorerHarness.deleteCalls).toEqual([]);
        expect(explorerHarness.mutationSequence).toEqual([
          "nvim:lock",
          "nvim:unlock",
        ]);
        expect(explorerHarness.logError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining(
              "authoritative Editor workspace fence is unavailable",
            ),
          }),
        );
      } finally {
        cleanupExplorer(root, stdin, stdout);
      }
    },
  );

  it("allows Project Explorer writes after a cleanup-confirmed Neovim startup error", async () => {
    explorerHarness.bufferSnapshot = {
      dirty: false,
      filePath: null,
      provider: { kind: "neovim" },
      providerStatus: "error",
      workspaceAuthorityRequired: false,
      buffers: [],
    };
    const { root, stdin, stdout } = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:addFile"]?.();
      await sleep();
      const submit = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
      submit?.("src/new.ts");
      await sleep();

      expect(explorerHarness.createCalls).toEqual(["src/new.ts"]);
      expect(explorerHarness.mutationSequence).toEqual([
        "nvim:lock",
        "disk:create:src/new.ts",
        "nvim:unlock",
      ]);
      expect(explorerHarness.logError).not.toHaveBeenCalled();
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it.each(["rename", "delete"] as const)(
    "holds the daemon Editor topology fence across the Project Explorer %s disk and Neovim transaction",
    async (mutation) => {
      explorerHarness.topologyEnabled = true;
      explorerHarness.bufferSnapshot = {
        dirty: false,
        filePath: "src/nested/app.ts",
        provider: { kind: "neovim" },
        providerStatus: "ready",
        buffers: [
          providerBuffer("src/nested/app.ts", {
            current: true,
            modified: false,
          }),
        ],
      };
      if (mutation === "delete") {
        explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, {
          selected: true,
          focused: true,
        });
      }
      const { root, stdin, stdout } = await renderExplorer({
        workbench: {
          activeSurfaceMode: "buffer",
          activeFilePath: "src/nested/app.ts",
        },
      });

      try {
        if (mutation === "rename") {
          explorerHarness.handlers["explorer:rename"]?.();
          await sleep();
          const submitRename = explorerHarness.textInputProps.at(-1)
            ?.onSubmit as ((value: string) => void) | undefined;
          submitRename?.("lib");
        } else {
          explorerHarness.handlers["explorer:delete"]?.();
          await sleep();
          explorerHarness.handlers["confirm:yes"]?.();
        }
        await sleep();

        expect(explorerHarness.topologyReserveCalls).toEqual([
          {
            workspaceRoot: "/repo",
            targets:
              mutation === "rename"
                ? [
                    {
                      path: "src",
                      includeDescendants: true,
                      allowOwnedClean: true,
                    },
                    {
                      path: "lib",
                      includeDescendants: true,
                      allowOwnedClean: false,
                    },
                  ]
                : [
                    {
                      path: "src/nested/app.ts",
                      includeDescendants: true,
                      allowOwnedClean: true,
                    },
                  ],
          },
        ]);
        expect(explorerHarness.mutationSequence).toEqual(
          mutation === "rename"
            ? [
                "nvim:lock",
                "daemon:reserve",
                "disk:rename:src:lib",
                "nvim:rename:src:lib",
                "daemon:complete:applied",
                "nvim:unlock",
              ]
            : [
                "nvim:lock",
                "daemon:reserve",
                "nvim:delete:src/nested/app.ts",
                "disk:delete:src/nested/app.ts",
                "daemon:complete:applied",
                "nvim:unlock",
              ],
        );
        expect(explorerHarness.topologyCompleteCalls).toEqual(["applied"]);
        expect(explorerHarness.topologyReleaseCalls).toBe(0);
      } finally {
        cleanupExplorer(root, stdin, stdout);
      }
    },
  );

  it("does not touch disk or Neovim when the Project Explorer topology reservation is rejected", async () => {
    const reservationFailure = new Error("workspace path is already fenced");
    explorerHarness.topologyEnabled = true;
    explorerHarness.topologyReserveError = reservationFailure;
    explorerHarness.bufferSnapshot = {
      dirty: false,
      filePath: "src/nested/app.ts",
      provider: { kind: "neovim" },
      providerStatus: "ready",
      buffers: [
        providerBuffer("src/nested/app.ts", {
          current: true,
          modified: false,
        }),
      ],
    };
    const { root, stdin, stdout } = await renderExplorer();

    try {
      explorerHarness.handlers["explorer:rename"]?.();
      await sleep();
      const submitRename = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
      submitRename?.("lib");
      await sleep();

      expect(explorerHarness.mutationSequence).toEqual([
        "nvim:lock",
        "daemon:reserve",
        "nvim:unlock",
      ]);
      expect(explorerHarness.renameCalls).toEqual([]);
      expect(explorerHarness.synchronizeRenameCalls).toEqual([]);
      expect(explorerHarness.topologyCompleteCalls).toEqual([]);
      expect(explorerHarness.topologyReleaseCalls).toBe(0);
      expect(explorerHarness.logError).toHaveBeenCalledWith(reservationFailure);
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it.each([
    { mutation: "rename", dirtyBuffer: "active" },
    { mutation: "rename", dirtyBuffer: "hidden" },
    { mutation: "delete", dirtyBuffer: "active" },
    { mutation: "delete", dirtyBuffer: "hidden" },
  ] as const)(
    "does not $mutation a path containing a dirty $dirtyBuffer buffer before approval or after cancel",
    async ({ dirtyBuffer, mutation }) => {
      const targetPath = "src/nested/app.ts";
      const activePath = dirtyBuffer === "active" ? targetPath : "other.ts";
      if (mutation === "delete") {
        explorerHarness.cursorRow = fileRow(targetPath, "app.ts", 3, {
          selected: true,
          focused: true,
        });
      }
      explorerHarness.bufferSnapshot = {
        dirty: true,
        filePath: activePath,
        buffers: [
          providerBuffer(activePath, {
            current: true,
            modified: dirtyBuffer === "active",
          }),
          ...(dirtyBuffer === "hidden"
            ? [providerBuffer(targetPath, { current: false, modified: true })]
            : []),
        ],
      };
      const { changes, dispatch, root, stdin, stdout } = await renderExplorer({
        workbench: {
          activeSurfaceMode: "buffer",
          activeFilePath: activePath,
          activeFileLine: 3,
        },
      });

      try {
        if (mutation === "rename") {
          explorerHarness.handlers["explorer:rename"]?.();
          await sleep();
          const submitRename = explorerHarness.textInputProps.at(-1)
            ?.onSubmit as ((value: string) => void) | undefined;
          submitRename?.("lib");
        } else {
          explorerHarness.handlers["explorer:delete"]?.();
          await sleep();
          explorerHarness.handlers["confirm:yes"]?.();
        }
        await sleep();

        expect(explorerHarness.renameCalls).toEqual([]);
        expect(explorerHarness.deleteCalls).toEqual([]);
        expect(changes.at(-1)?.workbench).toMatchObject({
          projectPathMutationRequest: null,
          pendingBlockedOverlay: {
            kind: "buffer-dirty",
            attemptedAction:
              mutation === "rename" ? "renaming src" : `deleting ${targetPath}`,
            deferredCommand:
              mutation === "rename"
                ? {
                    type: "requestProjectPathRename",
                    fromPath: "src",
                    toPath: "lib",
                  }
                : {
                    type: "requestProjectPathDelete",
                    path: targetPath,
                  },
          },
        });

        dispatch({ type: "clearBlockedOverlay" });
        await sleep();

        expect(explorerHarness.renameCalls).toEqual([]);
        expect(explorerHarness.deleteCalls).toEqual([]);
        expect(changes.at(-1)?.workbench).toMatchObject({
          projectPathMutationRequest: null,
          pendingBlockedOverlay: null,
          activeFilePath: activePath,
        });
      } finally {
        cleanupExplorer(root, stdin, stdout);
      }
    },
  );

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
              attachments: [
                {
                  id: "file-range:src/nested/app.ts:12-15",
                  kind: "file-range",
                  label: "src/nested/app.ts:12-15",
                  path: "src/nested/app.ts",
                  line: 12,
                  endLine: 15,
                },
              ],
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

      const submitRename = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
      expect(submitRename).toEqual(expect.any(Function));
      submitRename?.("lib/");
      await sleep();

      expect(explorerHarness.renameCalls).toEqual([["src", "lib/"]]);
      expect(explorerHarness.synchronizeRenameCalls).toEqual([["src", "lib/"]]);
      expect(explorerHarness.mutationSequence).toEqual([
        "nvim:lock",
        "disk:rename:src:lib/",
        "nvim:rename:src:lib/",
        "nvim:unlock",
      ]);
      expect(changes.at(-1)?.workbench).toMatchObject({
        activeWorkspaceView: "editor",
        focusedPane: "explorer",
        activeSurfaceMode: "buffer",
        activeFilePath: "lib/nested/app.ts",
        activeFileLine: 12,
        attachments: [
          {
            id: "file-range:lib/nested/app.ts:12-15",
            kind: "file-range",
            label: "lib/nested/app.ts:12-15",
            path: "lib/nested/app.ts",
            line: 12,
            endLine: 15,
          },
        ],
        // The renamed attachment remains in the Agent draft that owned it.
        // Opening the renamed buffer crosses into Editor without leaking that
        // draft's attachment into the Editor composer.
        composerAttachmentIds: [],
        agentComposerAttachmentIds: ["file-range:lib/nested/app.ts:12-15"],
        editorComposerAttachmentIds: [],
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it.each(["rename", "delete"] as const)(
    "keeps disk and Redux references unchanged when %s buffer synchronization fails",
    async (mutation) => {
      explorerHarness.topologyEnabled = true;
      explorerHarness.bufferSnapshot = {
        dirty: false,
        filePath: "src/nested/app.ts",
        provider: { kind: "neovim" },
        providerStatus: "ready",
        buffers: [
          providerBuffer("src/nested/app.ts", {
            current: true,
            modified: false,
          }),
        ],
      };
      const failure = `Neovim ${mutation} synchronization failed`;
      if (mutation === "rename") {
        explorerHarness.synchronizeRenameResult = {
          ok: false,
          reason: failure,
        };
      } else {
        explorerHarness.synchronizeDeleteResult = {
          ok: false,
          reason: failure,
        };
        explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, {
          selected: true,
          focused: true,
        });
      }
      const { changes, root, stdin, stdout } = await renderExplorer({
        workbench: {
          activeSurfaceMode: "preview",
          activeFilePath: "src/nested/app.ts",
          activeFileLine: 12,
        },
      });

      try {
        if (mutation === "rename") {
          explorerHarness.handlers["explorer:rename"]?.();
          await sleep();
          const submitRename = explorerHarness.textInputProps.at(-1)
            ?.onSubmit as ((value: string) => void) | undefined;
          submitRename?.("lib");
        } else {
          explorerHarness.handlers["explorer:delete"]?.();
          await sleep();
          explorerHarness.handlers["confirm:yes"]?.();
        }
        await sleep();

        expect(explorerHarness.mutationSequence).toEqual(
          mutation === "rename"
            ? [
                "nvim:lock",
                "daemon:reserve",
                "disk:rename:src:lib",
                "nvim:rename:src:lib",
                "disk:rename:lib:src",
                "daemon:release",
                "nvim:unlock",
              ]
            : [
                "nvim:lock",
                "daemon:reserve",
                "nvim:delete:src/nested/app.ts",
                "daemon:release",
                "nvim:unlock",
              ],
        );
        expect(explorerHarness.topologyCompleteCalls).toEqual([]);
        expect(explorerHarness.topologyReleaseCalls).toBe(1);
        expect(changes.at(-1)?.workbench).toMatchObject({
          activeSurfaceMode: "preview",
          activeFilePath: "src/nested/app.ts",
          activeFileLine: 12,
          projectPathMutationRequest: null,
        });
        expect(explorerHarness.deleteCalls).toEqual([]);
      } finally {
        cleanupExplorer(root, stdin, stdout);
      }
    },
  );

  it("fails closed without clobbering a recreated source when rename rollback loses a race", async () => {
    explorerHarness.topologyEnabled = true;
    explorerHarness.bufferSnapshot = {
      dirty: false,
      filePath: null,
      provider: { kind: "neovim" },
      providerStatus: "ready",
      buffers: [],
    };
    explorerHarness.synchronizeRenameResult = {
      ok: false,
      reason: "Neovim rename synchronization failed",
    };
    explorerHarness.rollbackRenameResult = {
      ok: false,
      error: "Cannot rename to src: path already exists.",
    };
    const { changes, root, stdin, stdout } = await renderExplorer({
      workbench: {
        activeSurfaceMode: "buffer",
        activeFilePath: "src/nested/app.ts",
        activeFileLine: 5,
      },
    });

    try {
      explorerHarness.handlers["explorer:rename"]?.();
      await sleep();
      const submitRename = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
      submitRename?.("lib");
      await vi.waitFor(() => {
        expect(explorerHarness.topologyCompleteCalls).toEqual([
          "unknown_outcome",
        ]);
      });

      expect(explorerHarness.mutationSequence).toEqual([
        "nvim:lock",
        "daemon:reserve",
        "disk:rename:src:lib",
        "nvim:rename:src:lib",
        "disk:rename:lib:src",
        "nvim:delete:src",
        "nvim:delete:lib",
        "daemon:complete:unknown_outcome",
        "nvim:unlock",
      ]);
      expect(explorerHarness.renameCalls).toEqual([
        ["src", "lib"],
        ["lib", "src"],
      ]);
      expect(explorerHarness.synchronizeDeleteCalls).toEqual(["src", "lib"]);
      expect(changes.at(-1)?.workbench).toMatchObject({
        activeSurfaceMode: "buffer",
        activeFilePath: "src/nested/app.ts",
        projectPathMutationRequest: null,
      });
    } finally {
      cleanupExplorer(root, stdin, stdout);
    }
  });

  it.each(["dirty-buffer", "agent-write"] as const)(
    "rechecks a late %s immediately after Neovim delete preparation and before disk removal",
    async (race) => {
      explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, {
        selected: true,
        focused: true,
      });
      explorerHarness.synchronizeDeleteSideEffect = () => {
        if (race === "agent-write") {
          explorerHarness.inFlightWithin = true;
          return;
        }
        explorerHarness.bufferSnapshot = {
          dirty: true,
          filePath: "src/nested/app.ts",
          buffers: [
            providerBuffer("src/nested/app.ts", {
              current: true,
              modified: true,
            }),
          ],
        };
      };
      const { changes, root, stdin, stdout } = await renderExplorer({
        workbench: {
          activeSurfaceMode: "buffer",
          activeFilePath: "src/nested/app.ts",
        },
      });

      try {
        explorerHarness.handlers["explorer:delete"]?.();
        await sleep();
        explorerHarness.handlers["confirm:yes"]?.();
        await sleep();

        expect(explorerHarness.synchronizeDeleteCalls).toEqual([
          "src/nested/app.ts",
        ]);
        expect(explorerHarness.deleteCalls).toEqual([]);
        expect(explorerHarness.mutationSequence).toEqual([
          "nvim:lock",
          "nvim:delete:src/nested/app.ts",
          "nvim:unlock",
        ]);
        expect(changes.at(-1)?.workbench).toMatchObject({
          activeFilePath: "src/nested/app.ts",
          projectPathMutationRequest: null,
        });
      } finally {
        cleanupExplorer(root, stdin, stdout);
      }
    },
  );

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

      const submitRename = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
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

  it("clears active and attached references when deleting their exact file", async () => {
    explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, {
      selected: true,
      focused: true,
    });
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

      expect(explorerHarness.deleteCalls).toEqual(["src/nested/app.ts"]);
      expect(changes.at(-1)?.workbench).toMatchObject({
        activeWorkspaceView: "agent",
        focusedPane: "surface",
        activeSurfaceMode: "transcript",
        activeFilePath: null,
        activeFileLine: null,
        attachments: [
          {
            id: "file:src-old/app.ts",
            kind: "file",
            label: "src-old/app.ts",
            path: "src-old/app.ts",
          },
        ],
        // Closing the deleted Editor buffer returns to Agent. The surviving
        // attachment stays with the Editor draft instead of appearing in the
        // Agent composer.
        composerAttachmentIds: [],
        agentComposerAttachmentIds: [],
        editorComposerAttachmentIds: ["file:src-old/app.ts"],
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("does not close a newer active file when delete finishes after navigation moved away", async () => {
    explorerHarness.deferDelete = true;
    explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, {
      selected: true,
      focused: true,
    });
    const changes: AppState[] = [];
    let setWorkbench:
      ((next: Partial<NonNullable<AppState["workbench"]>>) => void) | null =
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
              focusedPane: "explorer",
              activeSurfaceMode: "buffer",
              activeFilePath: "src/nested/app.ts",
              activeFileLine: 12,
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <WorkbenchStateSetter
            onReady={(setter) => {
              setWorkbench = setter;
            }}
          />
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
      expect(explorerHarness.deleteCalls).toEqual(["src/nested/app.ts"]);

      setWorkbench?.({
        activeSurfaceMode: "preview",
        activeFilePath: "other.ts",
        activeFileLine: 5,
      });
      await sleep();

      explorerHarness.pendingDeleteResolve?.({
        ok: true,
        path: "src/nested/app.ts",
      });
      await sleep();

      expect(explorerHarness.deleteCalls).toEqual(["src/nested/app.ts"]);
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

      const submitCreate = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
      expect(submitCreate).toEqual(expect.any(Function));
      submitCreate?.("src/new.ts");
      await sleep();

      expect(explorerHarness.logError).toHaveBeenCalledWith(createError);
      expect(explorerHarness.textInputProps.at(-1)?.focus).toBe(true);

      explorerHarness.rejectCreateError = null;
      const retryCreate = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
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

      const submitCreate = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
      submitCreate?.("src/new.ts");
      await sleep();

      expect(explorerHarness.logError).toHaveBeenCalledWith(
        "permission denied",
      );
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

      const submitRename = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
      expect(submitRename).toEqual(expect.any(Function));
      submitRename?.("lib/");
      await sleep();

      expect(explorerHarness.logError).toHaveBeenCalledWith(renameError);
      expect(explorerHarness.textInputProps.at(-1)?.focus).toBe(true);

      explorerHarness.rejectRenameError = null;
      const retryRename = explorerHarness.textInputProps.at(-1)?.onSubmit as
        ((value: string) => void) | undefined;
      retryRename?.("lib/");
      await sleep();

      expect(explorerHarness.renameCalls).toEqual([
        ["src", "lib/"],
        ["src", "lib/"],
      ]);
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
    explorerHarness.cursorRow = fileRow("src/nested/app.ts", "app.ts", 3, {
      selected: true,
      focused: true,
    });
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

      expect(explorerHarness.deleteCalls).toEqual([
        "src/nested/app.ts",
        "src/nested/app.ts",
      ]);
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
  readonly onReady: (
    setWorkbench: (next: Partial<NonNullable<AppState["workbench"]>>) => void,
  ) => void;
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

function WorkbenchDispatchProbe({
  onReady,
}: {
  readonly onReady: (dispatch: (command: WorkbenchCommand) => void) => void;
}): null {
  const dispatch = useWorkbenchDispatch();
  React.useEffect(() => {
    onReady(dispatch);
  }, [dispatch, onReady]);
  return null;
}

function providerBuffer(
  path: string,
  options: {
    readonly current: boolean;
    readonly modified: boolean;
  },
) {
  return {
    handle: options.current ? 1 : 2,
    name: path,
    filePath: path,
    absolutePath: `/repo/${path}`,
    listed: true,
    loaded: true,
    modified: options.modified,
    current: options.current,
    bufferType: "",
    modifiable: true,
    readOnly: false,
    saveable: true,
  };
}
