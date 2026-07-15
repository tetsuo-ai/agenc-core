import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from "../../../src/services/lsp/LSPDiagnosticRegistry.js";
import { runWithCwdOverride } from "../../../src/utils/cwd.js";
import { Box, createRoot, Text, useInput } from "../../../src/tui/ink.js";
import type { DOMElement } from "../../../src/tui/ink/dom.js";
import instances from "../../../src/tui/ink/instances.js";
import { nodeCache } from "../../../src/tui/ink/node-cache.js";
import { KeybindingSetup } from "../../../src/tui/keybindings/KeybindingProviderSetup.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import {
  getWorkbenchBufferStore,
  resetWorkbenchBufferStoreForTesting,
} from "../../../src/tui/workbench/buffer/BufferStore.js";
import {
  getWorkbenchBufferProviderController,
  resetWorkbenchBufferProviderControllerForTesting,
} from "../../../src/tui/workbench/buffer/providers/BufferProviderController.js";
import { createNeovimRenderSnapshot } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import { emptyProviderSnapshot, NEOVIM_BUFFER_CAPABILITIES } from "../../../src/tui/workbench/buffer/providers/types.js";
import { applyWorkbenchCommand, useWorkbenchDispatch } from "../../../src/tui/workbench/state.js";
import {
  BufferSurface,
  bufferStatusLabel,
  createBufferSurfaceKeyHandlers,
  diagnosticCoversLine,
  executeBufferVimCommand,
  oneLine,
} from "../../../src/tui/workbench/surfaces/BufferSurface.js";
import { WorkbenchLayout } from "../../../src/tui/workbench/WorkbenchLayout.js";

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
  (stdout as any as { columns: number; rows: number; isTTY: boolean }).columns = 80;
  (stdout as any as { columns: number; rows: number; isTTY: boolean }).rows = 24;
  (stdout as any as { columns: number; rows: number; isTTY: boolean }).isTTY = true;
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  return {
    stdin,
    stdout,
    output: () => stripAnsi(output),
  };
}

function sleep(ms = 100): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function findClickableBox(node: DOMElement): DOMElement | null {
  if (node.nodeName === "ink-box" && node._eventHandlers?.onClick) {
    return node;
  }
  for (const child of node.childNodes) {
    if (child.nodeName === "#text") continue;
    const found = findClickableBox(child);
    if (found) return found;
  }
  return null;
}

function findClickableBoxes(node: DOMElement, found: DOMElement[] = []): DOMElement[] {
  if (node.nodeName === "ink-box" && node._eventHandlers?.onClick) {
    found.push(node);
  }
  for (const child of node.childNodes) {
    if (child.nodeName !== "#text") findClickableBoxes(child, found);
  }
  return found;
}

type ActionStoreOverrides = { [Key in keyof ReturnType<typeof createActionStoreShape>]?: ReturnType<typeof createActionStoreShape>[Key] };

function createActionStore(overrides: ActionStoreOverrides = {}) {
  return {
    ...createActionStoreShape(),
    ...overrides,
  };
}

function createActionStoreShape() {
  return {
    save: vi.fn(async () => true),
    revert: vi.fn(async () => {}),
    close: vi.fn(async () => true),
    openExternalEditor: vi.fn(async () => true),
    undo: vi.fn(() => true),
    redo: vi.fn(() => true),
    move: vi.fn(() => true),
    requestHover: vi.fn(async () => "hover"),
    goToDefinition: vi.fn(async () => true),
  };
}

function LeakyInput({ leaked }: { readonly leaked: string[] }): null {
  useInput((input) => {
    leaked.push(input);
  });
  return null;
}

function OpenBufferRequest({ path }: { readonly path: string | null }): null {
  const dispatch = useWorkbenchDispatch();
  React.useEffect(() => {
    if (path) dispatch({ type: "openBuffer", path, line: 1, focus: true });
  }, [dispatch, path]);
  return null;
}

function OpenBufferRetryRequest({
  path,
  attempt,
}: {
  readonly path: string | null;
  readonly attempt: number;
}): null {
  const dispatch = useWorkbenchDispatch();
  React.useEffect(() => {
    if (path) dispatch({ type: "openBuffer", path, line: 1, focus: true });
  }, [attempt, dispatch, path]);
  return null;
}

let dir: string;
let previousBufferProvider: string | undefined;

beforeEach(async () => {
  previousBufferProvider = process.env.AGENC_BUFFER_PROVIDER;
  process.env.AGENC_BUFFER_PROVIDER = "inline";
  dir = await mkdtemp(join(tmpdir(), "agenc-buffer-surface-"));
});

afterEach(async () => {
  resetAllLSPDiagnosticState();
  await resetWorkbenchBufferProviderControllerForTesting();
  resetWorkbenchBufferStoreForTesting();
  if (previousBufferProvider === undefined) {
    delete process.env.AGENC_BUFFER_PROVIDER;
  } else {
    process.env.AGENC_BUFFER_PROVIDER = previousBufferProvider;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("BufferSurface", () => {
  it("exposes fully testable key handlers for inline and terminal providers", async () => {
    const store = createActionStore();
    const dispatch = vi.fn();
    const inlineSnapshot = {
      ...emptyProviderSnapshot({
        kind: "inline",
        label: "basic inline BUFFER fallback",
        fallbackReason: null,
        capabilities: {
          vimExact: false,
          terminalUi: false,
          mouse: false,
          clipboard: false,
          dirtyState: true,
          lspPassthrough: true,
          multiBuffer: false,
        },
      }),
      viewportRows: 1,
    };
    const handlers = createBufferSurfaceKeyHandlers({
      store,
      snapshot: inlineSnapshot,
      hasInFlightAgent: true,
      dispatch,
    });

    handlers["buffer:save"]?.();
    handlers["workbench:focusExplorer"]?.();
    handlers["workbench:focusAgents"]?.();
    handlers["workbench:focusComposer"]?.();
    await handlers["buffer:revert"]?.();
    await handlers["buffer:close"]?.();
    await handlers["buffer:closeDiscard"]?.();
    handlers["buffer:externalEditor"]?.();
    handlers["buffer:undo"]?.();
    handlers["buffer:redo"]?.();
    await handlers["buffer:hover"]?.();
    await handlers["buffer:definition"]?.();
    handlers["buffer:up"]?.();
    handlers["buffer:down"]?.();
    handlers["buffer:left"]?.();
    handlers["buffer:right"]?.();
    handlers["buffer:pageUp"]?.();
    handlers["buffer:pageDown"]?.();
    handlers["buffer:lineStart"]?.();
    handlers["buffer:lineEnd"]?.();
    handlers["buffer:top"]?.();
    handlers["buffer:bottom"]?.();
    handlers["buffer:selectUp"]?.();
    handlers["buffer:selectDown"]?.();
    handlers["buffer:selectLeft"]?.();
    handlers["buffer:selectRight"]?.();
    handlers["buffer:selectLineStart"]?.();
    handlers["buffer:selectLineEnd"]?.();
    await flush();

    expect(store.save).toHaveBeenCalledWith({ hasInFlightAgent: true });
    expect(dispatch).toHaveBeenCalledWith({ type: "focus", pane: "explorer" });
    expect(dispatch).toHaveBeenCalledWith({ type: "focus", pane: "agents" });
    expect(dispatch).toHaveBeenCalledWith({ type: "focus", pane: "composer" });
    expect(store.close).toHaveBeenCalledWith();
    expect(store.close).toHaveBeenCalledWith({ discard: true });
    expect(dispatch).toHaveBeenCalledWith({ type: "closeSurface" });
    expect(store.move).toHaveBeenCalledWith("up");
    expect(store.move).toHaveBeenCalledWith("down");
    expect(store.move).toHaveBeenCalledWith("left");
    expect(store.move).toHaveBeenCalledWith("right");
    expect(store.move).toHaveBeenCalledWith("up", { pageSize: 1 });
    expect(store.move).toHaveBeenCalledWith("down", { pageSize: 1 });
    expect(store.move).toHaveBeenCalledWith("lineStart");
    expect(store.move).toHaveBeenCalledWith("lineEnd");
    expect(store.move).toHaveBeenCalledWith("top");
    expect(store.move).toHaveBeenCalledWith("bottom");
    expect(store.move).toHaveBeenCalledWith("up", { extend: true });
    expect(store.move).toHaveBeenCalledWith("down", { extend: true });
    expect(store.move).toHaveBeenCalledWith("left", { extend: true });
    expect(store.move).toHaveBeenCalledWith("right", { extend: true });
    expect(store.move).toHaveBeenCalledWith("lineStart", { extend: true });
    expect(store.move).toHaveBeenCalledWith("lineEnd", { extend: true });

    const terminalHandlers = createBufferSurfaceKeyHandlers({
      store,
      snapshot: {
        ...inlineSnapshot,
        provider: {
          kind: "neovim",
          label: "embedded Neovim",
          fallbackReason: null,
          capabilities: NEOVIM_BUFFER_CAPABILITIES,
        },
        viewportRows: 6,
      },
      hasInFlightAgent: false,
      dispatch,
    });

    expect(terminalHandlers["buffer:revert"]?.()).toBe(false);
    expect(terminalHandlers["buffer:undo"]?.()).toBe(false);
    expect(terminalHandlers["buffer:redo"]?.()).toBe(false);
    expect(terminalHandlers["buffer:hover"]?.()).toBe(false);
    expect(terminalHandlers["buffer:definition"]?.()).toBe(false);
    terminalHandlers["buffer:pageUp"]?.();
    terminalHandlers["buffer:pageDown"]?.();
    expect(store.move).toHaveBeenCalledWith("up", { pageSize: 5 });
    expect(store.move).toHaveBeenCalledWith("down", { pageSize: 5 });

    const blockedCloseStore = createActionStore({
      close: vi.fn(async () => false),
    });
    const blockedDispatch = vi.fn();
    const blockedHandlers = createBufferSurfaceKeyHandlers({
      store: blockedCloseStore,
      snapshot: inlineSnapshot,
      hasInFlightAgent: false,
      dispatch: blockedDispatch,
    });
    await blockedHandlers["buffer:close"]?.();
    await blockedHandlers["buffer:closeDiscard"]?.();
    expect(blockedDispatch).not.toHaveBeenCalled();
  });

  it("executes inline command dispatch and helper edge cases", async () => {
    const store = createActionStore();
    const dispatch = vi.fn();

    executeBufferVimCommand({ type: "save", force: true }, { store, dispatch, hasInFlightAgent: true });
    executeBufferVimCommand({ type: "quit", discard: true, all: false }, { store, dispatch, hasInFlightAgent: false });
    executeBufferVimCommand({ type: "saveQuit", force: false, all: false }, { store, dispatch, hasInFlightAgent: false });
    await flush();

    expect(store.save).toHaveBeenCalledWith({ hasInFlightAgent: true, force: true });
    expect(store.close).toHaveBeenCalledWith({ discard: true });
    expect(store.close).toHaveBeenCalledWith();
    expect(dispatch).toHaveBeenCalledWith({ type: "closeSurface" });

    const blockedStore = createActionStore({
      save: vi.fn(async () => false),
      close: vi.fn(async () => false),
    });
    const blockedDispatch = vi.fn();
    executeBufferVimCommand({ type: "quit", discard: false, all: false }, {
      store: blockedStore,
      dispatch: blockedDispatch,
      hasInFlightAgent: false,
    });
    executeBufferVimCommand({ type: "saveQuit", force: true, all: false }, {
      store: blockedStore,
      dispatch: blockedDispatch,
      hasInFlightAgent: false,
    });
    await flush();
    expect(blockedDispatch).not.toHaveBeenCalled();

    const statusSnapshot = {
      ...emptyProviderSnapshot({
        kind: "inline",
        label: "basic inline BUFFER fallback",
        fallbackReason: null,
        capabilities: {
          vimExact: false,
          terminalUi: false,
          mouse: false,
          clipboard: false,
          dirtyState: true,
          lspPassthrough: true,
          multiBuffer: false,
        },
      }),
      dirty: true,
      encoding: "utf8" as const,
      lineEndings: "CRLF" as const,
    };
    expect(bufferStatusLabel(statusSnapshot, true)).toBe("idle, dirty, agent, utf8, CRLF");
    expect(oneLine(" alpha\n\t beta  ")).toBe("alpha beta");
    expect(diagnosticCoversLine({ message: "none", severity: "Error" } as any, 1)).toBe(false);
    expect(diagnosticCoversLine({
      message: "exact",
      severity: "Error",
      range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
    } as any, 3)).toBe(false);
    expect(diagnosticCoversLine({
      message: "span",
      severity: "Error",
      range: { start: { line: 1, character: 0 }, end: { line: 2, character: 4 } },
    } as any, 3)).toBe(true);
  });

  it("renders the empty BUFFER state when no active file is selected", async () => {
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          key="buffer-click-unfocused"
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "buffer",
              activeFilePath: null,
            },
          }}
        >
          <KeybindingSetup>
            <BufferSurface focused={false} />
          </KeybindingSetup>
        </AppStateProvider>,
      );
      await sleep();

      expect(output()).toContain("Nofileselected");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("renders editable buffer content without overflowing the terminal", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={false} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      const frame = output();
      expect(frame).toContain("BUFFER");
      expect(frame).toContain("target.ts");
      expect(frame).toMatch(/const\s+value\s*=\s*1;/u);
      for (const line of frame.split(/[\r\n]+/u)) {
        expect(line.length).toBeLessThanOrEqual(80);
      }
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("does not show an in-flight agent warning for longer sibling file names", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              tasks: {
                "agent-1": {
                  id: "agent-1",
                  type: "local_agent",
                  status: "running",
                  description: "editing target.tsx",
                } as any,
              },
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={false} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      const frame = output();
      expect(frame).toContain("target.ts");
      expect(frame).not.toContain("agent edit in flight");
      expect(frame).not.toMatch(/\bagent\b/u);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("does not treat local bash tasks as in-flight buffer edits", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              tasks: {
                "target.ts": {
                  id: "target.ts",
                  type: "local_bash",
                  status: "running",
                  description: "target.ts",
                } as any,
              },
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={false} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      expect(output()).not.toContain("agenteditinflight");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("shows pending agent edits that reference the active buffer", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              tasks: {
                "agent-pending": {
                  id: "agent-pending",
                  type: "local_agent",
                  status: "pending",
                  description: "target.ts",
                } as any,
              },
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={false} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      expect(output()).toContain("agenteditinflight");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("shows diagnostics that span the current buffer line", async () => {
    const filePath = join(dir, "target.ts");
    await writeFile(filePath, "function value() {\n  return 1;\n}\n", "utf8");
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{
        uri: filePath,
        diagnostics: [{
          message: "spans block",
          severity: "Error",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 2, character: 1 },
          },
        }],
      }],
    });
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 2,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={false} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      const frame = output();
      expect(frame).toMatch(/1\s*diagnostic/u);
      expect(frame).toMatch(/spans\s*block/u);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("renders diagnostic counts without a current-line message when the cursor is outside the range", async () => {
    const filePath = join(dir, "target.ts");
    await writeFile(filePath, "one\ntwo\nthree\n", "utf8");
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{
        uri: filePath,
        diagnostics: [{
          message: "line one only",
          severity: "Warning",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 3 },
          },
        }],
      }],
    });
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 3,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={false} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      const frame = output();
      expect(frame).toMatch(/1\s*diagnostic/u);
      expect(frame).not.toContain("lineoneonly");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("pluralizes diagnostics when multiple entries exist", async () => {
    const filePath = join(dir, "target.ts");
    await writeFile(filePath, "one\ntwo\n", "utf8");
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{
        uri: filePath,
        diagnostics: [
          {
            message: "first",
            severity: "Warning",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
          {
            message: "second",
            severity: "Warning",
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
          },
        ],
      }],
    });
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={false} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      expect(output()).toMatch(/2\s*diagnostics/u);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("opens the active file after saving a dirty-buffer conflict", async () => {
    await writeFile(join(dir, "first.ts"), "first\n", "utf8");
    await writeFile(join(dir, "second.ts"), "second\n", "utf8");
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    function App({ requestedPath }: { readonly requestedPath: string | null }): React.ReactElement {
      return (
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "buffer",
              activeFilePath: "first.ts",
              activeFileLine: 1,
            },
          }}
        >
          <KeybindingSetup>
            <OpenBufferRequest path={requestedPath} />
            <BufferSurface focused={true} />
          </KeybindingSetup>
        </AppStateProvider>
      );
    }

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(<App requestedPath={null} />);
        await sleep();

        const store = getWorkbenchBufferStore();
        expect(store.getSnapshot().filePath).toBe("first.ts");
        store.insert("draft ");
        expect(store.getSnapshot()).toMatchObject({
          filePath: "first.ts",
          dirty: true,
        });

        root.render(<App requestedPath="second.ts" />);
        await sleep();

        expect(store.getSnapshot()).toMatchObject({
          status: "conflict",
          conflictKind: "disk",
          filePath: "first.ts",
          dirty: true,
        });

        await expect(store.save()).resolves.toBe(true);
        await sleep();

        expect(await readFile(join(dir, "first.ts"), "utf8")).toBe("draft first\n");
        expect(store.getSnapshot()).toMatchObject({
          status: "ready",
          filePath: "second.ts",
          dirty: false,
        });
        expect(store.getText()).toBe("second\n");
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("retries the same active buffer path after an initial load error", async () => {
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    function App({ retryAttempt }: { readonly retryAttempt: number }): React.ReactElement {
      return (
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "buffer",
              activeFilePath: "missing.ts",
              activeFileLine: 1,
            },
          }}
        >
          <KeybindingSetup>
            <OpenBufferRetryRequest path={retryAttempt > 0 ? "missing.ts" : null} attempt={retryAttempt} />
            <BufferSurface focused={true} />
          </KeybindingSetup>
        </AppStateProvider>
      );
    }

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(<App retryAttempt={0} />);
        await sleep();

        const store = getWorkbenchBufferStore();
        expect(store.getSnapshot()).toMatchObject({
          status: "error",
          filePath: null,
        });

        await writeFile(join(dir, "missing.ts"), "created\n", "utf8");
        root.render(<App retryAttempt={1} />);
        await sleep();

        expect(store.getSnapshot()).toMatchObject({
          status: "ready",
          filePath: "missing.ts",
          dirty: false,
        });
        expect(store.getText()).toBe("created\n");
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("captures focused vim insert text before later input handlers", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });
    const leaked: string[] = [];

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={true} />
              <LeakyInput leaked={leaked} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      stdin.write("q");
      await sleep();

      expect(getWorkbenchBufferStore().getText()).toBe("const value = 1;\n");
      stdin.write("i");
      await sleep();
      stdin.write("q");
      await sleep();

      expect(getWorkbenchBufferStore().getText()).toBe("qconst value = 1;\n");
      expect(getWorkbenchBufferStore().getSnapshot().vimMode).toBe("INSERT");
      expect(leaked).toEqual([]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("opens the external editor from the explicit buffer handoff shortcut", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={true} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      const store = getWorkbenchBufferStore();
      expect(store.getSnapshot().vimMode).toBe("NORMAL");
      const openExternalEditor = vi
        .spyOn(store, "openExternalEditor")
        .mockResolvedValue(true);

      stdin.write("\x07");
      await sleep();

      expect(openExternalEditor).toHaveBeenCalledTimes(1);
      expect(store.getText()).toBe("const value = 1;\n");
      expect(store.getSnapshot().dirty).toBe(false);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("honors forced vim writes when the file changed on disk", async () => {
    const file = join(dir, "target.ts");
    await writeFile(file, "const value = 1;\n", "utf8");
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={true} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      const store = getWorkbenchBufferStore();
      await writeFile(file, "external change\n", "utf8");
      store.insert("draft ");

      stdin.write(":");
      await sleep();
      stdin.write("w");
      await sleep();
      stdin.write("!");
      await sleep();
      stdin.write("\r");
      await sleep();

      expect(await readFile(file, "utf8")).toBe("draft const value = 1;\n");
      expect(store.getSnapshot()).toMatchObject({
        status: "ready",
        conflictKind: null,
        dirty: false,
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("executes inline vim quit and save-quit commands through the provider boundary", async () => {
    const file = join(dir, "target.ts");
    await writeFile(file, "const value = 1;\n", "utf8");
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={true} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      stdin.write("i");
      await sleep();
      stdin.write("draft ");
      await sleep();
      stdin.write("\x1b");
      await sleep();
      stdin.write(":");
      await sleep();
      stdin.write("wq");
      await sleep();
      stdin.write("\r");
      await sleep();

      expect(await readFile(file, "utf8")).toBe("draft const value = 1;\n");
      expect(getWorkbenchBufferStore().getSnapshot().status).toBe("idle");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }

  });

  it("renders terminal Neovim snapshots and terminal-specific footer status", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    let terminalCommandLine: string | null = null;
    let providerListener: (() => void) | null = null;
    const identity = {
      kind: "neovim" as const,
      label: "embedded Neovim test",
      fallbackReason: null,
      capabilities: NEOVIM_BUFFER_CAPABILITIES,
    };
    const provider = {
      identity,
      subscribe: vi.fn((listener: () => void) => {
        providerListener = listener;
        return () => {};
      }),
      getSnapshot: vi.fn(() => ({
        ...emptyProviderSnapshot(identity),
        status: "ready",
        providerStatus: "ready",
        filePath: "target.ts",
        absolutePath: join(dir, "target.ts"),
        terminal: {
          ...createNeovimRenderSnapshot(4, 24),
          lines: ["alpha", "beta", "", ""],
          mode: "insert",
          commandLine: terminalCommandLine,
          cursor: { grid: 1, row: 1, column: 2 },
        },
        vimMode: "INSERT",
        position: { line: 2, column: 2, offset: 0 },
      })),
      getVisibleLines: vi.fn(() => []),
      open: vi.fn(async () => {}),
      save: vi.fn(async () => true),
      revert: vi.fn(async () => {}),
      close: vi.fn(async () => true),
      openExternalEditor: vi.fn(async () => true),
      undo: vi.fn(() => true),
      redo: vi.fn(() => true),
      move: vi.fn(() => false),
      requestHover: vi.fn(async () => null),
      goToDefinition: vi.fn(async () => false),
      handleInput: vi.fn(() => true),
      click: vi.fn(() => true),
      resize: vi.fn(),
      focus: vi.fn(),
      cleanup: vi.fn(async () => {}),
    };
    getWorkbenchBufferProviderController().setSelectionFactoryForTesting(async () => ({
      kind: "neovim",
      provider,
      discovery: {
        usable: true,
        executable: "nvim",
        version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
        args: ["--embed", "--clean", "-n"],
        useUserInit: false,
      },
    }));
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={true} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      const frame = output();
      expect(frame).toContain("embedded Neovim test");
      expect(frame).toContain("alpha");
      expect(frame).toContain("shift+tabcomposer");
      expect(frame).toContain("ctrl+xhexplorer");

      terminalCommandLine = "set number relativenumber wrapscan";
      providerListener?.();
      await sleep();

      expect(output()).toContain("set num");
      expect(provider.resize).toHaveBeenCalledWith({ rows: 15, columns: 76 });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("returns to the transcript when embedded Neovim exits from inside BUFFER", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const transcriptRendered = vi.fn();
    const TranscriptProbe = () => {
      transcriptRendered();
      return <Text>transcript after close</Text>;
    };
    let providerListener: (() => void) | null = null;
    let providerStatus: "ready" | "closed" = "ready";
    let providerMessage: string | null = null;
    const identity = {
      kind: "neovim" as const,
      label: "embedded Neovim test",
      fallbackReason: null,
      capabilities: NEOVIM_BUFFER_CAPABILITIES,
    };
    const provider = {
      identity,
      subscribe: vi.fn((listener: () => void) => {
        providerListener = listener;
        return () => {};
      }),
      getSnapshot: vi.fn(() => ({
        ...emptyProviderSnapshot(identity),
        status: providerStatus === "closed" ? "idle" as const : "ready" as const,
        providerStatus,
        providerMessage,
        filePath: "target.ts",
        absolutePath: join(dir, "target.ts"),
        terminal: {
          ...createNeovimRenderSnapshot(4, 24),
          lines: ["alpha", "beta", "", ""],
          mode: "normal",
          commandLine: null,
          cursor: { grid: 1, row: 0, column: 0 },
        },
        vimMode: "NORMAL" as const,
        position: { line: 1, column: 0, offset: 0 },
      })),
      getVisibleLines: vi.fn(() => []),
      open: vi.fn(async () => {}),
      save: vi.fn(async () => true),
      revert: vi.fn(async () => {}),
      close: vi.fn(async () => true),
      openExternalEditor: vi.fn(async () => false),
      undo: vi.fn(() => false),
      redo: vi.fn(() => false),
      move: vi.fn(() => false),
      requestHover: vi.fn(async () => null),
      goToDefinition: vi.fn(async () => false),
      handleInput: vi.fn(() => true),
      click: vi.fn(() => true),
      resize: vi.fn(),
      focus: vi.fn(),
      cleanup: vi.fn(async () => {}),
    };
    getWorkbenchBufferProviderController().setSelectionFactoryForTesting(async () => ({
      kind: "neovim",
      provider,
      discovery: {
        usable: true,
        executable: "nvim",
        version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
        args: ["--embed", "--clean", "-n"],
        useUserInit: false,
      },
    }));
    const changes: ReturnType<typeof getDefaultAppState>[] = [];
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
                focusedPane: "surface",
              },
            }}
            onChangeAppState={({ newState }) => {
              changes.push(newState);
            }}
          >
            <KeybindingSetup>
              <WorkbenchLayout
                transcript={<TranscriptProbe />}
                composer={<Text>composer</Text>}
              />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      expect(output()).toContain("embedded Neovim test");
      expect(transcriptRendered).not.toHaveBeenCalled();

      providerStatus = "closed";
      providerMessage = "Embedded Neovim exited.";
      providerListener?.();
      await sleep();

      expect(changes.some((state) => state.workbench.activeSurfaceMode === "transcript")).toBe(true);
      expect(transcriptRendered).toHaveBeenCalled();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("routes mouse clicks only from inside the BUFFER content pane", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const identity = {
      kind: "neovim" as const,
      label: "embedded Neovim test",
      fallbackReason: null,
      capabilities: NEOVIM_BUFFER_CAPABILITIES,
    };
    const provider = {
      identity,
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => ({
        ...emptyProviderSnapshot(identity),
        status: "ready",
        providerStatus: "ready",
        filePath: "target.ts",
        absolutePath: join(dir, "target.ts"),
        terminal: {
          ...createNeovimRenderSnapshot(4, 24),
          lines: ["alpha", "beta", "", ""],
          mode: "normal",
          commandLine: null,
          cursor: { grid: 1, row: 0, column: 0 },
        },
        vimMode: "NORMAL",
        position: { line: 1, column: 0, offset: 0 },
      })),
      getVisibleLines: vi.fn(() => []),
      open: vi.fn(async () => {}),
      save: vi.fn(async () => true),
      revert: vi.fn(async () => {}),
      close: vi.fn(async () => true),
      openExternalEditor: vi.fn(async () => false),
      undo: vi.fn(() => false),
      redo: vi.fn(() => false),
      move: vi.fn(() => false),
      requestHover: vi.fn(async () => null),
      goToDefinition: vi.fn(async () => false),
      handleInput: vi.fn(() => true),
      click: vi.fn(() => true),
      resize: vi.fn(),
      focus: vi.fn(),
      cleanup: vi.fn(async () => {}),
    };
    getWorkbenchBufferProviderController().setSelectionFactoryForTesting(async () => ({
      kind: "neovim",
      provider,
      discovery: {
        usable: true,
        executable: "nvim",
        version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
        args: ["--embed", "--clean", "-n"],
        useUserInit: false,
      },
    }));
    const { stdin, stdout } = createStreams();
    (stdout as any as { columns: number; rows: number }).columns = 160;
    const outsideClick = vi.fn();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
                focusedPane: "surface",
              },
            }}
          >
            <KeybindingSetup>
              <WorkbenchLayout
                transcript={<Text>transcript</Text>}
                composer={<Box onClick={outsideClick}><Text>composer</Text></Box>}
              />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      const instance = instances.get(stdout as any as NodeJS.WriteStream) as any;
      if (!instance?.rootNode) throw new Error("Ink instance not found");
      instance.setAltScreenActive(true);
      const clickBox = findClickableBox(instance.rootNode);
      if (!clickBox) throw new Error("BUFFER click box not found");
      const rect = nodeCache.get(clickBox);
      if (!rect) throw new Error("BUFFER click box has no layout");

      const outsideBox = findClickableBoxes(instance.rootNode).find((box) => box !== clickBox);
      if (!outsideBox) throw new Error("outside click box not found");
      const outsideRect = nodeCache.get(outsideBox);
      if (!outsideRect) throw new Error("outside click box has no layout");
      expect(instance.dispatchClick(outsideRect.x, outsideRect.y)).toBe(true);
      expect(provider.click).not.toHaveBeenCalled();
      expect(outsideClick).toHaveBeenCalledTimes(1);

      expect(instance.dispatchClick(rect.x + 1, rect.y + 1)).toBe(true);
      expect(provider.click).toHaveBeenCalledWith(1, 1);

      provider.click.mockClear();
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "buffer",
              activeFilePath: "target.ts",
              activeFileLine: 1,
              focusedPane: "composer",
            },
          }}
        >
          <KeybindingSetup>
            <BufferSurface focused={false} />
          </KeybindingSetup>
        </AppStateProvider>,
      );
      await sleep();
      const unfocusedClickBox = findClickableBox(instance.rootNode);
      if (!unfocusedClickBox) throw new Error("unfocused BUFFER click box not found");
      const unfocusedRect = nodeCache.get(unfocusedClickBox);
      if (!unfocusedRect) throw new Error("unfocused BUFFER click box has no layout");
      expect(instance.dispatchClick(unfocusedRect.x + 1, unfocusedRect.y + 1)).toBe(true);
      expect(provider.click).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("keeps focused BUFFER workbench focus chords inside the provider", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const identity = {
      kind: "neovim" as const,
      label: "embedded Neovim test",
      fallbackReason: null,
      capabilities: NEOVIM_BUFFER_CAPABILITIES,
    };
    const provider = {
      identity,
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => ({
        ...emptyProviderSnapshot(identity),
        status: "ready",
        providerStatus: "ready",
        filePath: "target.ts",
        absolutePath: join(dir, "target.ts"),
        terminal: {
          ...createNeovimRenderSnapshot(4, 24),
          lines: ["alpha", "beta", "", ""],
          mode: "normal",
          commandLine: null,
          cursor: { grid: 1, row: 0, column: 0 },
        },
        vimMode: "NORMAL",
        position: { line: 1, column: 0, offset: 0 },
      })),
      getVisibleLines: vi.fn(() => []),
      open: vi.fn(async () => {}),
      save: vi.fn(async () => true),
      revert: vi.fn(async () => {}),
      close: vi.fn(async () => true),
      openExternalEditor: vi.fn(async () => false),
      undo: vi.fn(() => false),
      redo: vi.fn(() => false),
      move: vi.fn(() => false),
      requestHover: vi.fn(async () => null),
      goToDefinition: vi.fn(async () => false),
      handleInput: vi.fn(() => true),
      click: vi.fn(() => true),
      resize: vi.fn(),
      focus: vi.fn(),
      cleanup: vi.fn(async () => {}),
    };
    getWorkbenchBufferProviderController().setSelectionFactoryForTesting(async () => ({
      kind: "neovim",
      provider,
      discovery: {
        usable: true,
        executable: "nvim",
        version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
        args: ["--embed", "--clean", "-n"],
        useUserInit: false,
      },
    }));
    const changes: ReturnType<typeof getDefaultAppState>[] = [];
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
                focusedPane: "surface",
              },
            }}
            onChangeAppState={({ newState }) => {
              changes.push(newState);
            }}
          >
            <KeybindingSetup>
              <WorkbenchLayout transcript={<Text>transcript</Text>} composer={<Text>composer</Text>} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      stdin.write("\x17");
      await sleep();
      stdin.write("h");
      await sleep();

      expect(provider.handleInput).toHaveBeenCalledWith(expect.objectContaining({
        input: "w",
        key: expect.objectContaining({ ctrl: true }),
      }));
      expect(provider.handleInput).toHaveBeenCalledWith(expect.objectContaining({ input: "h" }));
      expect(changes.every((state) => state.workbench.focusedPane !== "explorer")).toBe(true);
      expect(changes.every((state) => state.workbench.activeSurfaceMode === "buffer")).toBe(true);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("refuses dirty workbench surface switches before BUFFER unmount cleanup can discard edits", async () => {
    const identity = {
      kind: "neovim" as const,
      label: "embedded Neovim test",
      fallbackReason: null,
      capabilities: NEOVIM_BUFFER_CAPABILITIES,
    };
    const provider = {
      identity,
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => ({
        ...emptyProviderSnapshot(identity),
        status: "ready",
        providerStatus: "ready",
        filePath: "target.ts",
        absolutePath: join(dir, "target.ts"),
        dirty: true,
      })),
      getVisibleLines: vi.fn(() => []),
      open: vi.fn(async () => {}),
      save: vi.fn(async () => true),
      revert: vi.fn(async () => {}),
      close: vi.fn(async () => true),
      openExternalEditor: vi.fn(async () => false),
      undo: vi.fn(() => false),
      redo: vi.fn(() => false),
      move: vi.fn(() => false),
      requestHover: vi.fn(async () => null),
      goToDefinition: vi.fn(async () => false),
      handleInput: vi.fn(() => true),
      click: vi.fn(() => true),
      resize: vi.fn(),
      focus: vi.fn(),
      cleanup: vi.fn(async () => {}),
    };
    const controller = getWorkbenchBufferProviderController();
    controller.setSelectionFactoryForTesting(async () => ({
      kind: "neovim",
      provider,
      discovery: {
        usable: true,
        executable: "nvim",
        version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
        args: ["--embed", "--clean", "-n"],
        useUserInit: false,
      },
    }));
    await controller.open("target.ts", 1);

    const state = {
      ...getDefaultAppState(),
      workbench: {
        ...getDefaultAppState().workbench,
        activeSurfaceMode: "buffer" as const,
        activeFilePath: "target.ts",
        activeFileLine: 1,
      },
    };
    const next = applyWorkbenchCommand(state, {
      type: "openPreview",
      path: "other.ts",
      line: 4,
    });

    expect(next.workbench.activeSurfaceMode).toBe("buffer");
    expect(next.workbench.activeFilePath).toBe("target.ts");
    expect(next.workbench.pendingBlockedOverlay).toEqual({
      kind: "approval",
      requestId: "buffer-dirty-surface-switch",
      attemptedAction: "leaving dirty BUFFER",
    });
    expect(provider.cleanup).not.toHaveBeenCalled();
  });

  it("cleans up the active provider when the BUFFER surface unmounts", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    let cleanupStarted!: () => void;
    const cleanupSignal = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const identity = {
      kind: "neovim" as const,
      label: "embedded Neovim test",
      fallbackReason: null,
      capabilities: NEOVIM_BUFFER_CAPABILITIES,
    };
    const provider = {
      identity,
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => ({
        ...emptyProviderSnapshot(identity),
        status: "ready",
        providerStatus: "ready",
        filePath: "target.ts",
        absolutePath: join(dir, "target.ts"),
        terminal: {
          ...createNeovimRenderSnapshot(4, 24),
          lines: ["alpha", "", "", ""],
          mode: "normal",
          commandLine: null,
          cursor: { grid: 1, row: 0, column: 0 },
        },
      })),
      getVisibleLines: vi.fn(() => []),
      open: vi.fn(async () => {}),
      save: vi.fn(async () => true),
      revert: vi.fn(async () => {}),
      close: vi.fn(async () => true),
      openExternalEditor: vi.fn(async () => false),
      undo: vi.fn(() => false),
      redo: vi.fn(() => false),
      move: vi.fn(() => false),
      requestHover: vi.fn(async () => null),
      goToDefinition: vi.fn(async () => false),
      handleInput: vi.fn(() => true),
      click: vi.fn(() => true),
      resize: vi.fn(),
      focus: vi.fn(),
      cleanup: vi.fn(async () => {
        cleanupStarted();
      }),
    };
    getWorkbenchBufferProviderController().setSelectionFactoryForTesting(async () => ({
      kind: "neovim",
      provider,
      discovery: {
        usable: true,
        executable: "nvim",
        version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
        args: ["--embed", "--clean", "-n"],
        useUserInit: false,
      },
    }));
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={true} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      expect(provider.open).toHaveBeenCalledWith({ filePath: "target.ts", line: 1 });
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "transcript",
            },
          }}
        >
          <KeybindingSetup>
            <Text>transcript</Text>
          </KeybindingSetup>
        </AppStateProvider>,
      );
      await cleanupSignal;
      expect(provider.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("renders provider messages, hover text, command footer, insert and visual fallback footers, and in-flight task ids", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const identity = {
      kind: "inline" as const,
      label: "basic inline BUFFER fallback",
      fallbackReason: "fallback reason",
      capabilities: {
        vimExact: false,
        terminalUi: false,
        mouse: false,
        clipboard: false,
        dirtyState: true,
        lspPassthrough: true,
        multiBuffer: false,
      },
    };
    let mode: "INSERT" | "VISUAL" | "NORMAL" = "INSERT";
    let commandLine: string | null = "w";
    let providerListener: (() => void) | null = null;
    const provider = {
      identity,
      subscribe: vi.fn((listener: () => void) => {
        providerListener = listener;
        return () => {};
      }),
      getSnapshot: vi.fn(() => ({
        ...emptyProviderSnapshot(identity),
        status: "loading",
        providerStatus: "loading",
        providerMessage: "provider message",
        error: "provider conflict",
        conflictKind: "disk",
        filePath: "target.ts",
        absolutePath: join(dir, "target.ts"),
        hoverText: "hover\ntext",
        vimMode: mode,
        vimCommandLine: commandLine,
      })),
      getVisibleLines: vi.fn(() => [{ number: 1, text: "const value = 1;", from: 0, to: 16 }]),
      open: vi.fn(async () => {}),
      save: vi.fn(async () => true),
      revert: vi.fn(async () => {}),
      close: vi.fn(async () => true),
      openExternalEditor: vi.fn(async () => true),
      undo: vi.fn(() => true),
      redo: vi.fn(() => true),
      move: vi.fn(() => false),
      requestHover: vi.fn(async () => null),
      goToDefinition: vi.fn(async () => false),
      handleInput: vi.fn(() => true),
      click: vi.fn(() => false),
      resize: vi.fn(),
      focus: vi.fn(),
      cleanup: vi.fn(async () => {}),
    };
    getWorkbenchBufferProviderController().setSelectionFactoryForTesting(async () => ({
      kind: "inline",
      provider,
      discovery: null,
      reason: "fallback reason",
    }));
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    function App(): React.ReactElement {
      return (
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            tasks: {
              "target.ts": {
                id: "target.ts",
                type: "local_agent",
                status: "running",
              } as any,
            },
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "buffer",
              activeFilePath: "target.ts",
              activeFileLine: 1,
            },
          }}
        >
          <KeybindingSetup>
            <BufferSurface focused={true} />
          </KeybindingSetup>
        </AppStateProvider>
      );
    }

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(<App />);
        await sleep();
        commandLine = null;
        mode = "VISUAL";
        providerListener?.();
        await sleep();
        mode = "NORMAL";
        providerListener?.();
        await sleep();
        mode = "INSERT";
        providerListener?.();
        await sleep();
      });

      const frame = output();
      expect(frame).toContain("fallback reason");
      expect(frame.match(/fallback reason/gu) ?? []).toHaveLength(1);
      expect(frame).toContain("provid");
      expect(frame).toContain("provider conflict");
      expect(frame).toContain("Loading");
      expect(frame).toContain("agenteditinflight:target.ts");
      expect(frame).toContain("hovertext");
      expect(frame).toContain(":w");
      expect(frame).toContain("VISUAL");
      expect(frame).toContain("BASICFALLBACK");
      expect(frame).toContain("esc normal");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("renders loading as the detail when no active path exists but the provider is busy", async () => {
    const identity = {
      kind: "inline" as const,
      label: "basic inline BUFFER fallback",
      fallbackReason: null,
      capabilities: {
        vimExact: false,
        terminalUi: false,
        mouse: false,
        clipboard: false,
        dirtyState: true,
        lspPassthrough: true,
        multiBuffer: false,
      },
    };
    const provider = {
      identity,
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => ({
        ...emptyProviderSnapshot(identity),
        status: "loading",
        providerStatus: "loading",
        filePath: null,
      })),
      getVisibleLines: vi.fn(() => []),
      open: vi.fn(async () => {}),
      save: vi.fn(async () => true),
      revert: vi.fn(async () => {}),
      close: vi.fn(async () => true),
      openExternalEditor: vi.fn(async () => true),
      undo: vi.fn(() => true),
      redo: vi.fn(() => true),
      move: vi.fn(() => false),
      requestHover: vi.fn(async () => null),
      goToDefinition: vi.fn(async () => false),
      handleInput: vi.fn(() => true),
      click: vi.fn(() => false),
      resize: vi.fn(),
      focus: vi.fn(),
      cleanup: vi.fn(async () => {}),
    };
    const controller = getWorkbenchBufferProviderController();
    controller.setSelectionFactoryForTesting(async () => ({
      kind: "inline",
      provider,
      discovery: null,
      reason: "loading",
    }));
    await controller.open("target.ts", 1);
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "buffer",
              activeFilePath: null,
            },
          }}
        >
          <KeybindingSetup>
            <BufferSurface focused={false} />
          </KeybindingSetup>
        </AppStateProvider>,
      );
      await sleep();

      expect(output()).toContain("loading");
      expect(output()).toContain("Loading");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("does not set highlighted lines after unmount", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    await runWithCwdOverride(dir, async () => {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "buffer",
              activeFilePath: "target.ts",
              activeFileLine: 1,
            },
          }}
        >
          <KeybindingSetup>
            <BufferSurface focused={false} />
          </KeybindingSetup>
        </AppStateProvider>,
      );
      root.unmount();
      await sleep();
    });
    stdin.end();
    stdout.end();
  });

  it("extends the buffer selection with shifted arrow keybindings", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as any as NodeJS.ReadStream,
      stdout: stdout as any as NodeJS.WriteStream,
    });

    try {
      await runWithCwdOverride(dir, async () => {
        root.render(
          <AppStateProvider
            initialState={{
              ...getDefaultAppState(),
              workbench: {
                ...getDefaultAppState().workbench,
                activeSurfaceMode: "buffer",
                activeFilePath: "target.ts",
                activeFileLine: 1,
              },
            }}
          >
            <KeybindingSetup>
              <BufferSurface focused={true} />
            </KeybindingSetup>
          </AppStateProvider>,
        );
        await sleep();
      });

      const store = getWorkbenchBufferStore();
      expect(store.getSnapshot().vimMode).toBe("NORMAL");
      stdin.write("\x1b[1;2C");
      await sleep();

      expect(store.getSnapshot().selection).toEqual({ anchor: 0, head: 1 });
      expect(store.getSnapshot().position.column).toBe(1);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
