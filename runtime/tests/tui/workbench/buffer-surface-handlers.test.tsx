import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from "../../../src/services/lsp/LSPDiagnosticRegistry.js";
import { AppStateProvider, getDefaultAppState, type AppState } from "../../../src/tui/state/AppState.js";
import {
  INLINE_BUFFER_CAPABILITIES,
  type BufferProviderSnapshot,
} from "../../../src/tui/workbench/buffer/providers/types.js";
import { BufferSurface } from "../../../src/tui/workbench/surfaces/BufferSurface.js";
import { renderToString } from "../../../src/utils/staticRender.js";

type BufferSnapshot = BufferProviderSnapshot;
type BufferStoreHarness = ReturnType<typeof createStoreHarness>;
type CapturedInputHandler = (input: string, key: Record<string, unknown>, event: InputCaptureEvent) => boolean;
type InputCaptureEvent = {
  readonly key: Record<string, unknown>;
  readonly keypress: { readonly isPasted: boolean };
};
type VimCommand =
  | { readonly type: "save"; readonly force: boolean }
  | { readonly type: "quit"; readonly discard: boolean; readonly all: boolean }
  | { readonly type: "saveQuit"; readonly force: boolean; readonly all: boolean };

const bufferHarness = vi.hoisted(() => ({
  handlers: {} as Record<string, () => void | false | Promise<void>>,
  highlightBufferVisibleLines: vi.fn(),
  inputCapture: null as CapturedInputHandler | null,
  inputCaptureOptions: null as Record<string, unknown> | null,
  keybindingOptions: null as Record<string, unknown> | null,
  logError: vi.fn(),
  snapshot: null as BufferSnapshot | null,
  store: null as BufferStoreHarness | null,
  terminalSize: { rows: 12, columns: 44 },
  vimCommandExecutor: null as ((command: VimCommand) => void) | null,
  visibleLines: [{ number: 1, text: "const value = 1;", from: 0, to: 16 }],
}));

vi.mock("../../../src/utils/log.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/utils/log.js")>(),
  logError: bufferHarness.logError,
}));

vi.mock("../../../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => bufferHarness.terminalSize,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useInputCapture: (
    handler: CapturedInputHandler,
    options: Record<string, unknown>,
  ) => {
    bufferHarness.inputCapture = handler;
    bufferHarness.inputCaptureOptions = options;
  },
  useKeybinding: () => {},
  useKeybindings: (
    handlers: Record<string, () => void | false | Promise<void>>,
    options: Record<string, unknown>,
  ) => {
    bufferHarness.handlers = handlers;
    bufferHarness.keybindingOptions = options;
  },
}));

vi.mock("../../../src/tui/workbench/buffer/providers/BufferProviderController.js", () => ({
  getWorkbenchBufferProviderController: () => bufferHarness.store,
}));

vi.mock("../../../src/tui/workbench/buffer/highlight.js", () => ({
  highlightBufferVisibleLines: bufferHarness.highlightBufferVisibleLines,
}));

vi.mock("../../../src/tui/workbench/buffer/useBufferStore.js", () => ({
  useBufferStore: () => bufferHarness.snapshot,
}));

beforeEach(() => {
  resetHarness();
});

describe("BufferSurface handlers", () => {
  it("routes buffer keybindings to the buffer store and closes the surface only after a successful close", async () => {
    const changes: AppState[] = [];

    await renderBufferSurface({ changes, includeInFlightAgent: true });

    expect(bufferHarness.keybindingOptions).toEqual({ context: "Buffer", isActive: true });
    expect(bufferHarness.inputCaptureOptions).toEqual({ context: "Buffer", isActive: true });
    expect(bufferHarness.store?.open).toHaveBeenCalledWith("target.ts", 1);
    expect(bufferHarness.store?.resize).toHaveBeenCalledWith({ rows: 3, columns: 40 });

    bufferHarness.handlers["buffer:save"]?.();
    expect(bufferHarness.store?.save).toHaveBeenCalledWith({ hasInFlightAgent: true });

    bufferHarness.handlers["buffer:revert"]?.();
    bufferHarness.handlers["buffer:externalEditor"]?.();
    bufferHarness.handlers["buffer:undo"]?.();
    bufferHarness.handlers["buffer:redo"]?.();
    bufferHarness.handlers["buffer:hover"]?.();
    bufferHarness.handlers["buffer:definition"]?.();

    expect(bufferHarness.store?.revert).toHaveBeenCalledTimes(1);
    expect(bufferHarness.store?.openExternalEditor).toHaveBeenCalledTimes(1);
    expect(bufferHarness.store?.undo).toHaveBeenCalledTimes(1);
    expect(bufferHarness.store?.redo).toHaveBeenCalledTimes(1);
    expect(bufferHarness.store?.requestHover).toHaveBeenCalledTimes(1);
    expect(bufferHarness.store?.goToDefinition).toHaveBeenCalledTimes(1);

    bufferHarness.store?.close.mockReturnValueOnce(false);
    await bufferHarness.handlers["buffer:close"]?.();
    expect(changes).toHaveLength(0);

    bufferHarness.store?.close.mockReturnValueOnce(true);
    await bufferHarness.handlers["buffer:close"]?.();
    expect(changes.at(-1)?.workbench.activeSurfaceMode).toBe("transcript");

    bufferHarness.store?.close.mockReturnValueOnce(true);
    await bufferHarness.handlers["buffer:closeDiscard"]?.();
    expect(bufferHarness.store?.close).toHaveBeenLastCalledWith({ discard: true });

    bufferHarness.handlers["buffer:up"]?.();
    bufferHarness.handlers["buffer:down"]?.();
    bufferHarness.handlers["buffer:left"]?.();
    bufferHarness.handlers["buffer:right"]?.();
    bufferHarness.handlers["buffer:pageUp"]?.();
    bufferHarness.handlers["buffer:pageDown"]?.();
    bufferHarness.handlers["buffer:lineStart"]?.();
    bufferHarness.handlers["buffer:lineEnd"]?.();
    bufferHarness.handlers["buffer:top"]?.();
    bufferHarness.handlers["buffer:bottom"]?.();
    bufferHarness.handlers["buffer:selectUp"]?.();
    bufferHarness.handlers["buffer:selectDown"]?.();
    bufferHarness.handlers["buffer:selectLeft"]?.();
    bufferHarness.handlers["buffer:selectRight"]?.();
    bufferHarness.handlers["buffer:selectLineStart"]?.();
    bufferHarness.handlers["buffer:selectLineEnd"]?.();

    expect(bufferHarness.store?.move.mock.calls).toEqual([
      ["up"],
      ["down"],
      ["left"],
      ["right"],
      ["up", { pageSize: 1 }],
      ["down", { pageSize: 1 }],
      ["lineStart"],
      ["lineEnd"],
      ["top"],
      ["bottom"],
      ["up", { extend: true }],
      ["down", { extend: true }],
      ["left", { extend: true }],
      ["right", { extend: true }],
      ["lineStart", { extend: true }],
      ["lineEnd", { extend: true }],
    ]);
  });

  it("executes Vim command callbacks through the focused input capture", async () => {
    const changes: AppState[] = [];

    await renderBufferSurface({ changes, columns: 24 });

    bufferHarness.inputCapture?.(":", {}, inputEvent());
    expect(bufferHarness.store?.handleInput).toHaveBeenCalledWith(
      ":",
      {},
      { columns: 20, rows: 3 },
      expect.any(Function),
      false,
    );

    const execute = bufferHarness.vimCommandExecutor;
    expect(execute).toBeTruthy();

    execute?.({ type: "save", force: true });
    expect(bufferHarness.store?.save).toHaveBeenLastCalledWith({
      force: true,
      hasInFlightAgent: false,
    });

    bufferHarness.store?.close.mockReturnValueOnce(false);
    execute?.({ type: "quit", discard: false, all: false });
    expect(changes).toHaveLength(0);

    bufferHarness.store?.close.mockReturnValueOnce(true);
    execute?.({ type: "quit", discard: true, all: false });
    await flushPromises();
    expect(changes.at(-1)?.workbench.activeSurfaceMode).toBe("transcript");
    expect(bufferHarness.store?.close).toHaveBeenLastCalledWith({ discard: true });

    const closeCallsAfterQuit = bufferHarness.store?.close.mock.calls.length ?? 0;
    bufferHarness.store?.save.mockResolvedValueOnce(false);
    execute?.({ type: "saveQuit", force: false, all: false });
    await flushPromises();
    expect(bufferHarness.store?.close).toHaveBeenCalledTimes(closeCallsAfterQuit);

    bufferHarness.store?.save.mockResolvedValueOnce(true);
    bufferHarness.store?.close.mockReturnValueOnce(false);
    execute?.({ type: "saveQuit", force: false, all: false });
    await flushPromises();
    expect(bufferHarness.store?.close).toHaveBeenCalledTimes(closeCallsAfterQuit + 1);

    bufferHarness.store?.save.mockResolvedValueOnce(true);
    bufferHarness.store?.close.mockReturnValueOnce(true);
    execute?.({ type: "saveQuit", force: true, all: false });
    await flushPromises();
    expect(bufferHarness.store?.save).toHaveBeenLastCalledWith({
      force: true,
      hasInFlightAgent: false,
    });
    expect(bufferHarness.store?.close).toHaveBeenCalledTimes(closeCallsAfterQuit + 2);
    expect(changes.at(-1)?.workbench.activeSurfaceMode).toBe("transcript");
  });

  it("contains rejected BUFFER open, close, command, and unmount actions", async () => {
    const changes: AppState[] = [];
    bufferHarness.store?.open.mockRejectedValueOnce(new Error("open cleanup failed"));

    await renderBufferSurface({ changes });
    await flushPromises();

    expect(bufferHarness.logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "open cleanup failed" }),
    );

    bufferHarness.store?.close.mockRejectedValueOnce(new Error("close cleanup failed"));
    await expect(bufferHarness.handlers["buffer:closeDiscard"]?.()).resolves.toBeUndefined();
    expect(changes).toHaveLength(0);
    expect(bufferHarness.logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "close cleanup failed" }),
    );

    for (const [action, method, message] of [
      ["buffer:save", "save", "save failed"],
      ["buffer:revert", "revert", "revert failed"],
      ["buffer:externalEditor", "openExternalEditor", "external editor failed"],
      ["buffer:hover", "requestHover", "hover failed"],
      ["buffer:definition", "goToDefinition", "definition failed"],
    ] as const) {
      bufferHarness.store?.[method].mockRejectedValueOnce(new Error(message));
      bufferHarness.handlers[action]?.();
      await flushPromises();
      expect(bufferHarness.logError).toHaveBeenCalledWith(
        expect.objectContaining({ message }),
      );
    }

    bufferHarness.inputCapture?.(":", {}, inputEvent());
    const execute = bufferHarness.vimCommandExecutor;
    expect(execute).toBeTruthy();
    bufferHarness.store?.close.mockRejectedValueOnce(new Error("command cleanup failed"));
    execute?.({ type: "quit", discard: true, all: false });
    await flushPromises();
    expect(changes).toHaveLength(0);
    expect(bufferHarness.logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "command cleanup failed" }),
    );

    bufferHarness.store?.save.mockRejectedValueOnce(new Error("command save failed"));
    execute?.({ type: "save", force: true, all: false });
    await flushPromises();
    expect(bufferHarness.logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "command save failed" }),
    );

    bufferHarness.store?.save.mockRejectedValueOnce(new Error("save-quit save failed"));
    execute?.({ type: "saveQuit", force: false, all: false });
    await flushPromises();
    expect(changes).toHaveLength(0);
    expect(bufferHarness.logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "save-quit save failed" }),
    );

    bufferHarness.store?.close.mockRejectedValueOnce(new Error("save-quit cleanup failed"));
    execute?.({ type: "saveQuit", force: false, all: false });
    await flushPromises();
    expect(changes).toHaveLength(0);
    expect(bufferHarness.logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "save-quit cleanup failed" }),
    );

    bufferHarness.store?.cleanup.mockRejectedValueOnce(new Error("unmount cleanup failed"));
    await renderBufferSurface({ activeFilePath: null });
    await flushPromises();
    expect(bufferHarness.logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "unmount cleanup failed" }),
    );
  });

  it("renders the empty surface without opening a buffer when no file is selected", async () => {
    bufferHarness.snapshot = baseSnapshot({
      filePath: null,
      status: "idle",
    });

    const output = await renderBufferSurface({ activeFilePath: null, columns: 100 });

    expect(output).toContain("No file selected");
    expect(bufferHarness.store?.open).not.toHaveBeenCalled();
  });

  it("renders the loading fallback when the active path is still unknown", async () => {
    bufferHarness.snapshot = baseSnapshot({
      filePath: null,
      status: "loading",
    });

    const output = await renderBufferSurface({ activeFilePath: null, columns: 100 });

    expect(output).toContain("loading [basic inline BUFFER fallback, normal, loading]");
    expect(output).toContain("Loading...");
    expect(bufferHarness.store?.open).not.toHaveBeenCalled();
  });

  it("renders diagnostics, in-flight agent state, hover text, and visual footer details", async () => {
    const absolutePath = "/tmp/agenc-buffer-surface-target.ts";
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{
        uri: absolutePath,
        diagnostics: [
          { message: "no range" },
          {
            message: "current line",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 2, character: 0 },
            },
          },
        ],
      }],
    });
    bufferHarness.snapshot = baseSnapshot({
      absolutePath,
      dirty: true,
      encoding: "utf8",
      filePath: null,
      hoverText: "hover\n  details",
      lineEndings: "LF",
      position: { line: 2, column: 4, offset: 17 },
      vimMode: "VISUAL",
    });

    const output = await renderBufferSurface({
      columns: 100,
      includeInFlightAgent: true,
      tasks: {
        bash: {
          id: "bash",
          type: "local_bash",
          status: "running",
          description: "target.ts",
        } as any,
        done: {
          id: "done",
          type: "local_agent",
          status: "completed",
          description: "target.ts",
        } as any,
        "target.ts": {
          id: "target.ts",
          type: "local_agent",
          status: "pending",
        } as any,
      },
    });

    expect(output).toContain("target.ts [basic inline BUFFER fallback, visual, ready, dirty, agent, utf8, LF] 2:4");
    expect(output).toContain("2 diagnostics - current line");
    expect(output).toContain("agent edit in flight: target.ts");
    expect(output).toContain("hover details");
    expect(output).toContain("VISUAL");
  });

  it("renders command-line and insert-mode footers", async () => {
    bufferHarness.snapshot = baseSnapshot({
      vimCommandLine: "wq",
      vimMode: "NORMAL",
    });

    const commandOutput = await renderBufferSurface({ columns: 100 });
    expect(commandOutput).toContain("target.ts [basic inline BUFFER fallback, command, ready]");
    expect(commandOutput).toContain(":wq");

    bufferHarness.snapshot = baseSnapshot({
      vimMode: "INSERT",
    });

    const insertOutput = await renderBufferSurface({ columns: 100 });
    expect(insertOutput).toContain("target.ts [basic inline BUFFER fallback, insert, ready]");
    expect(insertOutput).toContain("INSERT  esc normal");
  });

  it("ignores late syntax highlights after unmounting", async () => {
    let resolveHighlights: ((value: ReadonlyMap<number, string>) => void) | null = null;
    bufferHarness.highlightBufferVisibleLines.mockImplementationOnce(() =>
      new Promise<ReadonlyMap<number, string>>((resolve) => {
        resolveHighlights = resolve;
      })
    );

    await renderBufferSurface();
    expect(resolveHighlights).toBeTruthy();

    resolveHighlights?.(new Map([[1, "const"]]));
    await flushPromises();

    expect(bufferHarness.highlightBufferVisibleLines).toHaveBeenCalledWith(
      "target.ts",
      [{ number: 1, text: "const value = 1;", from: 0, to: 16 }],
    );
  });
});

async function renderBufferSurface({
  activeFileLine = 1,
  activeFilePath = "target.ts",
  changes = [],
  columns = 44,
  includeInFlightAgent = false,
  tasks,
}: {
  readonly activeFileLine?: number | null;
  readonly activeFilePath?: string | null;
  readonly changes?: AppState[];
  readonly columns?: number;
  readonly includeInFlightAgent?: boolean;
  readonly tasks?: AppState["tasks"];
} = {}): Promise<string> {
  bufferHarness.terminalSize = { rows: 12, columns };
  const defaultState = getDefaultAppState();
  return renderToString(
    <AppStateProvider
      initialState={{
        ...defaultState,
        tasks: tasks ?? (
          includeInFlightAgent
            ? {
                "agent-1": {
                  id: "agent-1",
                  type: "local_agent",
                  status: "running",
                  description: "editing target.ts",
                } as any,
              }
            : defaultState.tasks
        ),
        workbench: {
          ...defaultState.workbench,
          activeSurfaceMode: "buffer",
          activeFileLine,
          activeFilePath,
        },
      }}
      onChangeAppState={({ newState }) => changes.push(newState)}
    >
      <BufferSurface focused={true} />
    </AppStateProvider>,
    { columns, rows: 12 },
  );
}

function resetHarness(): void {
  resetAllLSPDiagnosticState();
  bufferHarness.handlers = {};
  bufferHarness.highlightBufferVisibleLines.mockReset();
  bufferHarness.highlightBufferVisibleLines.mockResolvedValue(new Map());
  bufferHarness.inputCapture = null;
  bufferHarness.inputCaptureOptions = null;
  bufferHarness.keybindingOptions = null;
  bufferHarness.logError.mockReset();
  bufferHarness.snapshot = baseSnapshot();
  bufferHarness.store = createStoreHarness();
  bufferHarness.terminalSize = { rows: 12, columns: 44 };
  bufferHarness.vimCommandExecutor = null;
  bufferHarness.visibleLines = [{ number: 1, text: "const value = 1;", from: 0, to: 16 }];
}

function baseSnapshot(overrides: Partial<BufferProviderSnapshot> = {}): BufferProviderSnapshot {
  const status = overrides.status ?? "ready";
  return {
    absolutePath: null,
    canRedo: false,
    canUndo: false,
    conflictKind: null,
    dirty: false,
    encoding: null,
    error: null,
    filePath: "target.ts",
    hoverText: null,
    lineCount: 1,
    lineEndings: null,
    position: { line: 1, column: 0, offset: 0 },
    scrollLine: 0,
    selection: { anchor: 0, head: 0 },
    status,
    viewportRows: 1,
    vimCommandLine: null,
    vimMode: "NORMAL",
    provider: {
      kind: "inline",
      label: "basic inline BUFFER fallback",
      fallbackReason: null,
      capabilities: INLINE_BUFFER_CAPABILITIES,
    },
    providerMessage: null,
    providerStatus: status,
    terminal: null,
    ...overrides,
  };
}

function createStoreHarness() {
  return {
    close: vi.fn(() => true),
    cleanup: vi.fn(async () => {}),
    click: vi.fn(() => false),
    focus: vi.fn(),
    getSnapshot: vi.fn(() => bufferHarness.snapshot),
    getVisibleLines: vi.fn(() => bufferHarness.visibleLines),
    goToDefinition: vi.fn(async () => false),
    handleInput: vi.fn((
      _input: string,
      _key: Record<string, unknown>,
      _context: Record<string, unknown>,
      execute: (command: VimCommand) => void,
      _isPasted: boolean,
    ) => {
      bufferHarness.vimCommandExecutor = execute;
      return true;
    }),
    move: vi.fn(),
    open: vi.fn(async () => {}),
    openExternalEditor: vi.fn(async () => true),
    redo: vi.fn(),
    requestHover: vi.fn(async () => null),
    revert: vi.fn(async () => {}),
    resize: vi.fn(),
    save: vi.fn(async () => true),
    undo: vi.fn(),
  };
}

function inputEvent(): InputCaptureEvent {
  return {
    key: {},
    keypress: { isPasted: false },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
