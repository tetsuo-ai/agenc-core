import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";

const searchHarness = vi.hoisted(() => ({
  handlers: {} as Record<string, () => void>,
  lines: [] as string[],
}));

vi.mock("../../../src/utils/ripgrep.js", () => ({
  ripGrepStream: vi.fn(async (
    _args: string[],
    _target: string,
    _signal: AbortSignal,
    onLines: (lines: string[]) => void,
  ) => {
    onLines(searchHarness.lines);
  }),
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => void>) => {
    searchHarness.handlers = handlers;
  },
}));

import { createRoot } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState, type AppState } from "../../../src/tui/state/AppState.js";
import { SearchSurface, SearchSurfaceView } from "../../../src/tui/workbench/surfaces/SearchSurface.js";
import { renderToString } from "../../../src/utils/staticRender.js";

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

describe("SearchSurface", () => {
  it("renders loading, no result, error, and truncated states", async () => {
    const loading = await renderToString(
      <SearchSurfaceView query="needle" matches={[]} selected={0} loading={true} error={null} focused={true} />,
      80,
    );
    const empty = await renderToString(
      <SearchSurfaceView query="needle" matches={[]} selected={0} loading={false} error={null} focused={true} />,
      80,
    );
    const error = await renderToString(
      <SearchSurfaceView query="needle" matches={[]} selected={0} loading={false} error="ripgrep failed" focused={true} />,
      80,
    );
    const truncated = await renderToString(
      <SearchSurfaceView
        query="needle"
        matches={Array.from({ length: 500 }, (_, index) => ({
          id: `src/app.ts:${index + 1}:needle`,
          file: "src/app.ts",
          line: index + 1,
          text: "needle",
        }))}
        selected={0}
        loading={false}
        error={null}
        focused={true}
      />,
      80,
    );

    expect(loading).toContain("searching");
    expect(empty).toContain("No results");
    expect(error).toContain("ripgrep failed");
    expect(truncated).toContain("Results truncated at 500 matches");
  });

  it("renders grouped results and selected match actions without overflow", async () => {
    const output = await renderToString(
      <SearchSurfaceView
        query="needle"
        matches={[
          { id: "src/app.ts:4:needle", file: "src/app.ts", line: 4, text: "const needle = true" },
          { id: "src/other.ts:9:needle", file: "src/other.ts", line: 9, text: "needle()" },
        ]}
        selected={1}
        loading={false}
        error={null}
        focused={true}
      />,
      60,
    );

    expect(output).toContain("src/app.ts");
    expect(output).toContain("src/other.ts");
    expect(output).toContain("@ attach");
    for (const line of output.split(/\r?\n/u)) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("clamps stale selection to a live match", async () => {
    const output = await renderToString(
      <SearchSurfaceView
        query="needle"
        matches={[
          { id: "src/app.ts:4:needle", file: "src/app.ts", line: 4, text: "const needle = true" },
          { id: "src/other.ts:9:needle", file: "src/other.ts", line: 9, text: "needle()" },
        ]}
        selected={99}
        loading={false}
        error={null}
        focused={true}
      />,
      80,
    );

    expect(output).toContain("src/other.ts:9");
    expect(output).toContain("@ attach");
  });

  it("selects the requested search match id after ripgrep results load", async () => {
    searchHarness.lines = [
      "src/first.ts:4:const needle = true",
      "src/second.ts:9:needle()",
    ];
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
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "search",
              searchQuery: "needle",
              selectedSearchMatchId: "src/second.ts:9:needle()",
            },
          }}
          onChangeAppState={({ newState }) => changes.push(newState)}
        >
          <SearchSurface focused={false} />
        </AppStateProvider>,
      );
      await sleep();

      expect(compact(output())).toContain("src/second.ts");
      searchHarness.handlers["surface:open"]?.();

      expect(changes.at(-1)?.workbench).toMatchObject({
        activeSurfaceMode: "buffer",
        activeFilePath: "src/second.ts",
        activeFileLine: 9,
        focusedPane: "surface",
      });
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
