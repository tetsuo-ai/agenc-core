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
import { createRoot, useInput } from "../../../src/tui/ink.js";
import { KeybindingSetup } from "../../../src/tui/keybindings/KeybindingProviderSetup.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import {
  getWorkbenchBufferStore,
  resetWorkbenchBufferStoreForTesting,
} from "../../../src/tui/workbench/buffer/BufferStore.js";
import { useWorkbenchDispatch } from "../../../src/tui/workbench/state.js";
import { BufferSurface } from "../../../src/tui/workbench/surfaces/BufferSurface.js";

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
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 80;
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

function sleep(ms = 100): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-buffer-surface-"));
});

afterEach(async () => {
  resetAllLSPDiagnosticState();
  resetWorkbenchBufferStoreForTesting();
  await rm(dir, { recursive: true, force: true });
});

describe("BufferSurface", () => {
  it("renders editable buffer content without overflowing the terminal", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout, output } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
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
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
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
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
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

  it("opens the active file after saving a dirty-buffer conflict", async () => {
    await writeFile(join(dir, "first.ts"), "first\n", "utf8");
    await writeFile(join(dir, "second.ts"), "second\n", "utf8");
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
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

  it("captures focused vim insert text before later input handlers", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
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

  it("opens the external editor when enter is pressed in normal mode", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
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

      stdin.write("\r");
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

  it("extends the buffer selection with shifted arrow keybindings", async () => {
    await writeFile(join(dir, "target.ts"), "const value = 1;\n", "utf8");
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
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
