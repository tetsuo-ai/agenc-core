import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const searchHarness = vi.hoisted(() => ({
  handlers: {} as Record<string, () => void>,
  lines: [] as string[],
  autoFlush: true,
  calls: [] as Array<{
    readonly args: string[];
    readonly target: string;
    readonly signal: AbortSignal;
    readonly onLines: (lines: string[]) => void;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }>,
}));

vi.mock("../../../src/utils/ripgrep.js", () => ({
  ripGrepStream: vi.fn((
    args: string[],
    target: string,
    signal: AbortSignal,
    onLines: (lines: string[]) => void,
  ) => {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    searchHarness.calls.push({ args, target, signal, onLines, resolve, reject });
    if (searchHarness.autoFlush) {
      onLines(searchHarness.lines);
      resolve();
    }
    return promise;
  }),
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => void>) => {
    searchHarness.handlers = handlers;
  },
}));

import { createRoot } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState, type AppState, useSetAppState } from "../../../src/tui/state/AppState.js";
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

function SearchQueryController({
  onReady,
}: {
  readonly onReady: (setSearchQuery: (query: string) => void) => void;
}): null {
  const setAppState = useSetAppState();
  React.useEffect(() => {
    onReady((searchQuery: string) => {
      setAppState((state) => ({
        ...state,
        workbench: {
          ...state.workbench,
          searchQuery,
          selectedSearchMatchId: null,
        },
      }));
    });
  }, [onReady, setAppState]);
  return null;
}

describe("SearchSurface", () => {
  beforeEach(() => {
    searchHarness.handlers = {};
    searchHarness.lines = [];
    searchHarness.autoFlush = true;
    searchHarness.calls = [];
  });

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

  it("ignores line batches from an aborted search stream", async () => {
    searchHarness.autoFlush = false;
    let setSearchQuery: ((query: string) => void) | null = null;
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
              searchQuery: "old",
            },
          }}
        >
          <SearchQueryController onReady={(setter) => { setSearchQuery = setter; }} />
          <SearchSurface focused={false} />
        </AppStateProvider>,
      );
      await sleep(180);

      expect(searchHarness.calls).toHaveLength(1);
      const staleCall = searchHarness.calls[0]!;
      setSearchQuery?.("new");
      await sleep(20);

      expect(staleCall.signal.aborted).toBe(true);
      staleCall.onLines(["src/old.ts:7:old result"]);
      staleCall.resolve();
      await sleep(50);

      expect(compact(output())).not.toContain("src/old.ts");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("clears previous search results as soon as the query changes", async () => {
    searchHarness.autoFlush = false;
    let setSearchQuery: ((query: string) => void) | null = null;
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
              searchQuery: "old",
            },
          }}
        >
          <SearchQueryController onReady={(setter) => { setSearchQuery = setter; }} />
          <SearchSurface focused={false} />
        </AppStateProvider>,
      );
      await sleep(180);

      const oldCall = searchHarness.calls[0]!;
      oldCall.onLines(["src/old.ts:7:old result"]);
      oldCall.resolve();
      await sleep(50);

      expect(compact(output())).toContain("src/old.ts");

      const beforeQueryChange = output();
      setSearchQuery?.("new");
      await sleep(20);

      const afterQueryChange = output().slice(beforeQueryChange.length);
      expect(compact(afterQueryChange)).not.toContain("src/old.ts");
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
