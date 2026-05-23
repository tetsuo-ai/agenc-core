import { PassThrough } from "node:stream";
import path from "node:path";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from "../../../src/services/lsp/LSPDiagnosticRegistry.js";
import { createRoot } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { PreviewSurface } from "../../../src/tui/workbench/surfaces/PreviewSurface.js";

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

afterEach(() => {
  resetAllLSPDiagnosticState();
});

describe("PreviewSurface", () => {
  it("renders an empty preview without crashing when no file is selected", async () => {
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
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: null,
              activeFileLine: null,
            },
          }}
        >
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );
      await sleep();

      const frame = output();
      expect(compact(frame)).toContain("Nofileselected");
      expect(frame).not.toContain("ERROR");
      expect(frame).not.toContain("setGitState");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("renders read-only file content without overflowing the terminal", async () => {
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
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "package.json",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );
      await sleep();

      const frame = output();
      expect(frame).toContain("PREVIEW");
      expect(frame).toContain("[read-only");
      expect(frame).toContain("package.json");
      for (const line of frame.split(/\r?\n/u)) {
        expect(line.length).toBeLessThanOrEqual(80);
      }
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("renders missing-file errors and pending LSP diagnostic counts", async () => {
    registerPendingLSPDiagnostic({
      serverName: "ts",
      files: [{
        uri: path.resolve(process.cwd(), "missing-preview-target.ts"),
        diagnostics: [{
          message: "broken",
          severity: "Error",
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
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "missing-preview-target.ts",
              activeFileLine: 1,
            },
          }}
        >
          <PreviewSurface focused={false} />
        </AppStateProvider>,
      );
      await sleep();

      const frame = output();
      expect(frame).toMatch(/1\s*diagnostic/u);
      expect(frame).toMatch(/ENOENT|no such file/i);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}
