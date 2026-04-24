import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { describe, expect, test, vi } from "vitest";

import type { PermissionMode } from "../../permissions/types.js";
import { PasteStore } from "../composer/paste-store.js";
import { Composer } from "../composer/Composer.js";
import {
  KeybindingProvider,
} from "../keybindings/KeybindingContext.js";
import {
  AgenCAppStateProvider,
  type ConfigStoreLike,
  type SessionLike,
} from "../state/AppState.js";
import Box from "./components/Box.js";
import ScrollBox, { type ScrollBoxHandle } from "./components/ScrollBox.js";
import StdinContext from "./components/StdinContext.js";
import Text from "./components/Text.js";
import { AlternateScreen } from "./components/AlternateScreen.js";
import { EventEmitter } from "./events/emitter.js";
import { InputEvent } from "./events/input-event.js";
import type { FrameEvent } from "./frame.js";
import instances from "./instances.js";
import { createRoot } from "./root.js";
import { charInCellAt } from "./screen.js";

type TestStdout = PassThrough & {
  isTTY: true;
  columns: number;
  rows: number;
};

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
  resume: () => TestStdin;
  pause: () => TestStdin;
};

type InkProbe = {
  setSearchHighlight(query: string): void;
  handleMultiClick(col: number, row: number, count: 2 | 3): void;
  handleSelectionDrag(col: number, row: number): void;
  clearTextSelection(): void;
  hasTextSelection(): boolean;
  frontFrame?: { screen?: { width: number; height: number } };
};

type StressControls = {
  appendRows(count: number): void;
  tick(): void;
  scrollBy(delta: number): void;
};

function createStreams(columns = 80, rows = 20, stdinIsTTY = false): {
  readonly stdout: TestStdout;
  readonly stderr: PassThrough;
  readonly stdin: TestStdin;
} {
  const stdout = new PassThrough() as TestStdout;
  Object.defineProperty(stdout, "isTTY", { value: true });
  Object.defineProperty(stdout, "columns", { value: columns, writable: true });
  Object.defineProperty(stdout, "rows", { value: rows, writable: true });

  const stderr = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = stdinIsTTY;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  return { stdout, stderr, stdin };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await sleep(20);
  }
}

async function mount(
  element: React.ReactElement,
  options: {
    readonly onFrame?: (event: FrameEvent) => void;
    readonly onInputActivity?: () => void;
    readonly columns?: number;
    readonly rows?: number;
    readonly stdinIsTTY?: boolean;
  } = {},
): Promise<{
  readonly stdout: TestStdout;
  readonly stdin: TestStdin;
  readonly unmount: () => void;
}> {
  const { stdout, stderr, stdin } = createStreams(
    options.columns,
    options.rows,
    options.stdinIsTTY,
  );
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    onFrame: options.onFrame,
    onInputActivity: options.onInputActivity,
  });

  root.render(element);
  await sleep(40);

  return {
    stdout,
    stdin,
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
      stderr.end();
    },
  };
}

function getInk(stdout: TestStdout): InkProbe {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | InkProbe
    | undefined;
  if (!instance) throw new Error("Ink instance missing");
  return instance;
}

function latestFrameText(stdout: TestStdout): string {
  const screen = getInk(stdout).frontFrame?.screen;
  if (!screen) return "";

  const rows: string[] = [];
  for (let y = 0; y < screen.height; y += 1) {
    let row = "";
    for (let x = 0; x < screen.width; x += 1) {
      row += charInCellAt(screen as never, x, y) ?? " ";
    }
    rows.push(row.replace(/\s+$/u, ""));
  }
  return rows.join("\n");
}

function makeKeyEvent(opts: {
  readonly name?: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}): InputEvent {
  return new InputEvent({
    kind: "key" as const,
    name: opts.name ?? opts.sequence ?? "",
    fn: false,
    ctrl: !!opts.ctrl,
    meta: !!opts.meta,
    shift: !!opts.shift,
    option: false,
    super: false,
    sequence: opts.sequence ?? "",
    raw: opts.sequence ?? "",
    isPasted: false,
  } as never);
}

async function typeText(emitter: EventEmitter, text: string): Promise<void> {
  for (const ch of text) {
    emitter.emit("input", makeKeyEvent({ name: ch, sequence: ch }));
    await sleep(12);
  }
}

function makeSession(cwd: string): SessionLike {
  return {
    cwd,
    home: cwd,
    services: {
      permissionModeRegistry: {
        current: () => ({ mode: "default" as PermissionMode }),
        subscribeToModeChange: () => () => undefined,
      },
    },
    abortTerminal: vi.fn(),
  };
}

function withInputProviders(
  emitter: EventEmitter,
  child: React.ReactElement,
): React.ReactElement {
  return (
    <StdinContext.Provider
      value={{
        stdin: process.stdin,
        setRawMode: () => undefined,
        isRawModeSupported: true,
        internal_exitOnCtrlC: true,
        internal_eventEmitter: emitter,
        internal_querier: null,
      }}
    >
      <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
        {child}
      </KeybindingProvider>
    </StdinContext.Provider>
  );
}

function initialRows(count = 40): string[] {
  return Array.from({ length: count }, (_, index) =>
    index % 5 === 0
      ? `row ${index} needle streaming transcript payload`
      : `row ${index} stable transcript payload`,
  );
}

function StressSurface({
  cwd,
  emitter,
  onReady,
  initialRowCount = 40,
}: {
  readonly cwd: string;
  readonly emitter: EventEmitter;
  readonly onReady: (controls: StressControls) => void;
  readonly initialRowCount?: number;
}): React.ReactElement {
  const [rows, setRows] = useState<readonly string[]>(() =>
    initialRows(initialRowCount),
  );
  const [tick, setTick] = useState(0);
  const scrollRef = useRef<ScrollBoxHandle>(null);
  const pasteStore = useMemo(() => new PasteStore(), []);
  const session = useMemo(() => makeSession(cwd), [cwd]);
  const configStore = useMemo<ConfigStoreLike>(() => ({ current: () => ({}) }), []);

  useEffect(() => {
    onReady({
      appendRows(count) {
        setRows((previous) => [
          ...previous,
          ...Array.from({ length: count }, (_, index) => {
            const next = previous.length + index;
            return `row ${next} needle appended stream chunk ${tick}`;
          }),
        ]);
      },
      tick() {
        setTick((value) => value + 1);
      },
      scrollBy(delta) {
        scrollRef.current?.scrollBy(delta);
      },
    });
  }, [onReady, tick]);

  return withInputProviders(
    emitter,
    <AgenCAppStateProvider session={session} configStore={configStore}>
      <AlternateScreen mouseTracking={false}>
        <Box flexDirection="column" width="100%" height="100%">
          <Box flexDirection="row">
            <Text>{tick % 2 === 0 ? "stream +" : "stream *"}</Text>
            <Text> frame {tick}</Text>
          </Box>
          <ScrollBox ref={scrollRef} height={12} width="100%" stickyScroll>
            {rows.map((line, index) => (
              <Text key={`${index}:${line}`}>{line}</Text>
            ))}
          </ScrollBox>
          <Composer
            session={{ cwd, home: cwd }}
            onSubmit={() => undefined}
            pasteStore={pasteStore}
          />
        </Box>
      </AlternateScreen>
    </AgenCAppStateProvider>,
  );
}

describe("TUI stress regressions", () => {
  test("streaming, overlays, resize, selection, scroll, and @file palette share a stable frame path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-tui-stress-"));
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "alpha.ts"), "export const alpha = 1;\n");

    const emitter = new EventEmitter();
    const frames: FrameEvent[] = [];
    let controls: StressControls | null = null;

    const { stdout, unmount } = await mount(
      <StressSurface
        cwd={cwd}
        emitter={emitter}
        onReady={(next) => {
          controls = next;
        }}
      />,
      {
        rows: 20,
        onFrame: (event) => frames.push(event),
      },
    );

    try {
      await waitFor(() => controls !== null);
      await waitFor(() => latestFrameText(stdout).includes("stream"));
      const liveControls = controls!;

      for (let i = 0; i < 6; i += 1) {
        liveControls.tick();
        liveControls.appendRows(3);
        await sleep(25);
      }

      const ink = getInk(stdout);
      ink.setSearchHighlight("needle");
      await waitFor(() => latestFrameText(stdout).includes("needle"));

      ink.handleMultiClick(2, 4, 2);
      await waitFor(() => ink.hasTextSelection());
      ink.handleSelectionDrag(12, 6);
      await sleep(30);

      liveControls.scrollBy(9);
      await sleep(120);

      stdout.columns = 96;
      stdout.rows = 22;
      stdout.emit("resize");
      await sleep(80);

      await typeText(emitter, "@alp");
      await waitFor(() => latestFrameText(stdout).includes("src/alpha.ts"));

      emitter.emit("input", makeKeyEvent({ name: "return", sequence: "\r" }));
      await waitFor(() => latestFrameText(stdout).includes("@src/alpha.ts"));

      const stressFrames = frames.slice(1);
      expect(stressFrames.length).toBeGreaterThan(4);
      expect(stressFrames.flatMap((frame) => frame.flickers)).toEqual([]);
      expect(
        Math.max(...stressFrames.map((frame) => frame.durationMs)),
      ).toBeLessThan(1_000);
      expect(
        stressFrames.some((frame) => (frame.phases?.patches ?? 0) > 0),
      ).toBe(true);
    } finally {
      unmount();
    }
  });

  test("long transcript history stays measurable without frame contamination", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-tui-long-history-"));
    const emitter = new EventEmitter();
    const frames: FrameEvent[] = [];
    let controls: StressControls | null = null;

    const { stdout, unmount } = await mount(
      <StressSurface
        cwd={cwd}
        emitter={emitter}
        initialRowCount={600}
        onReady={(next) => {
          controls = next;
        }}
      />,
      {
        rows: 24,
        onFrame: (event) => frames.push(event),
      },
    );

    try {
      await waitFor(() => controls !== null);
      await waitFor(() => latestFrameText(stdout).includes("stream"));
      const liveControls = controls!;

      liveControls.scrollBy(580);
      await sleep(80);
      liveControls.appendRows(80);
      liveControls.tick();
      await sleep(80);

      const ink = getInk(stdout);
      ink.setSearchHighlight("needle");
      await waitFor(() => latestFrameText(stdout).includes("needle"));

      stdout.columns = 110;
      stdout.rows = 26;
      stdout.emit("resize");
      await sleep(80);

      const stressFrames = frames.slice(1);
      expect(stressFrames.length).toBeGreaterThan(2);
      expect(stressFrames.flatMap((frame) => frame.flickers)).toEqual([]);
      expect(
        Math.max(...stressFrames.map((frame) => frame.durationMs)),
      ).toBeLessThan(1_000);
    } finally {
      unmount();
    }
  });

  test("onInputActivity fires from the real stdin parser without extra stream listeners", async () => {
    function InputProbe(): React.ReactElement {
      const stdin = useContext(StdinContext);
      useEffect(() => {
        stdin.setRawMode(true);
        return () => {
          stdin.setRawMode(false);
        };
      }, [stdin]);
      return <Text>input probe</Text>;
    }

    let inputEvents = 0;
    const { stdin, unmount } = await mount(<InputProbe />, {
      onInputActivity: () => {
        inputEvents += 1;
      },
      stdinIsTTY: true,
    });

    try {
      stdin.write("x");
      await waitFor(() => inputEvents > 0);
      expect(inputEvents).toBeGreaterThan(0);
    } finally {
      unmount();
    }
  });
});
