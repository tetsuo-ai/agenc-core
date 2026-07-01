import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import App, { handleMouseEvent } from "../../../src/tui/ink/components/App.js";
import {
  getTuiBackpressureSnapshot,
  resetTuiBackpressureForTesting,
} from "../../../src/tui/backpressure.js";
import type { ParsedMouse } from "../../../src/tui/ink/parse-keypress.js";
import { createSelectionState } from "../../../src/tui/ink/selection.js";
import { DISABLE_MOUSE_TRACKING, HIDE_CURSOR, SHOW_CURSOR } from "../../../src/tui/ink/termio/dec.js";
import {
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  FOCUS_IN,
  FOCUS_OUT,
  PASTE_START,
} from "../../../src/tui/ink/termio/csi.js";
import {
  getTerminalFocused,
  resetTerminalFocusState,
} from "../../../src/tui/ink/terminal-focus-state.js";
import { env } from "../../../src/utils/env.js";

type TestStream = NodeJS.ReadStream & NodeJS.WriteStream;
type TestTtyStream = TestStream & {
  isRaw?: boolean;
  writes: string[];
  ref: ReturnType<typeof vi.fn>;
  setRawMode: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};
type AppProps = ConstructorParameters<typeof App>[0];
const originalTerminal = env.terminal;

function stream(): TestStream {
  const s = new PassThrough() as TestStream;
  s.isTTY = false;
  s.write = vi.fn(() => true) as never;
  return s;
}

function ttyStream(): TestTtyStream {
  const s = new PassThrough() as TestTtyStream;
  s.isTTY = true;
  s.isRaw = false;
  s.writes = [];
  s.ref = vi.fn();
  s.unref = vi.fn();
  s.setRawMode = vi.fn((mode: boolean) => {
    s.isRaw = mode;
  });
  s.write = vi.fn((chunk: string | Uint8Array) => {
    s.writes.push(String(chunk));
    return true;
  }) as never;
  return s;
}

function throwingReadableHarness(error: unknown): TestStream {
  const readableListeners: Array<(...args: unknown[]) => void> = [];
  const s = {
    isTTY: false,
    write: vi.fn(() => true),
    read: vi.fn(() => {
      throw error;
    }),
    listeners: vi.fn((event: string) => event === "readable" ? readableListeners : []),
    addListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "readable") {
        readableListeners.push(listener);
      }
      return s;
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "readable") {
        const index = readableListeners.indexOf(listener);
        if (index >= 0) {
          readableListeners.splice(index, 1);
        }
      }
      return s;
    }),
  };
  return s as unknown as TestStream;
}

function readableChunksHarness(chunks: Array<string | null>): TestStream {
  const s = {
    isTTY: false,
    write: vi.fn(() => true),
    read: vi.fn(() => chunks.shift() ?? null),
    listeners: vi.fn(() => []),
    addListener: vi.fn(() => s),
    removeListener: vi.fn(() => s),
  };
  return s as unknown as TestStream;
}

async function flushImmediateTicks(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function mouse(
  action: ParsedMouse["action"],
  button: number,
  col = 5,
  row = 7,
): ParsedMouse {
  return {
    action,
    button,
    col,
    kind: "mouse",
    row,
    sequence: `mouse:${action}:${button}:${col}:${row}`,
  };
}

function appProps(overrides: Partial<AppProps> = {}): AppProps {
  return {
    children: null,
    stdin: stream(),
    stdout: stream(),
    stderr: stream(),
    exitOnCtrlC: true,
    onExit: () => {},
    terminalColumns: 80,
    terminalRows: 24,
    selection: createSelectionState(),
    onSelectionChange: () => {},
    onClickAt: () => false,
    onHoverAt: () => {},
    getHyperlinkAt: () => undefined,
    onOpenHyperlink: () => {},
    onMultiClick: () => {},
    onSelectionDrag: () => {},
    dispatchKeyboardEvent: () => {},
    ...overrides,
  };
}

function createApp(overrides: Partial<AppProps> = {}): App {
  return new App(appProps(overrides));
}

function deepestRenderedChild(node: unknown): unknown {
  let current = node as any;
  for (let depth = 0; depth < 12; depth += 1) {
    if (!current?.props || current.props.children === undefined) {
      return current;
    }
    current = current.props.children;
  }
  return current;
}

function cursorDeclarationValue(node: unknown): (...args: unknown[]) => void {
  let current = node as any;
  for (let depth = 0; depth < 5; depth += 1) {
    current = current.props.children;
  }
  return current.props.value;
}

afterEach(() => {
  resetTuiBackpressureForTesting();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  env.terminal = originalTerminal;
  resetTerminalFocusState();
});

describe("Ink App coverage swarm row 010", () => {
  test("ignores mouse handling when click handling is disabled", () => {
    vi.stubEnv("AGENC_DISABLE_MOUSE_CLICKS", "1");

    const selection = createSelectionState();
    const onSelectionChange = vi.fn();
    const onClickAt = vi.fn(() => false);
    const app = createApp({
      selection,
      onClickAt,
      onSelectionChange,
    });

    handleMouseEvent(app, mouse("press", 0));

    expect(selection.anchor).toBeNull();
    expect(onClickAt).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  test("finishes a stale drag on no-button motion and deduplicates hover", () => {
    const selection = createSelectionState();
    selection.isDragging = true;
    const onHoverAt = vi.fn();
    const onSelectionChange = vi.fn();
    const app = createApp({
      selection,
      onHoverAt,
      onSelectionChange,
    });

    handleMouseEvent(app, mouse("press", 0x20 | 0x03, 3, 4));
    handleMouseEvent(app, mouse("press", 0x20 | 0x03, 3, 4));

    expect(selection.isDragging).toBe(false);
    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(onHoverAt).toHaveBeenCalledOnce();
    expect(onHoverAt).toHaveBeenCalledWith(2, 3);
  });

  test("routes drag motion and non-left button edge cases", () => {
    const selection = createSelectionState();
    const onSelectionDrag = vi.fn();
    const onSelectionChange = vi.fn();
    const app = createApp({
      selection,
      onSelectionDrag,
      onSelectionChange,
    });

    handleMouseEvent(app, mouse("press", 0x20, 9, 11));
    expect(onSelectionDrag).toHaveBeenCalledWith(8, 10);
    expect(onSelectionChange).not.toHaveBeenCalled();

    app.clickCount = 2;
    handleMouseEvent(app, mouse("press", 1));
    expect(app.clickCount).toBe(0);

    handleMouseEvent(app, mouse("release", 1));
    expect(onSelectionChange).not.toHaveBeenCalled();

    selection.isDragging = true;
    handleMouseEvent(app, mouse("release", 1));
    expect(selection.isDragging).toBe(false);
    expect(onSelectionChange).toHaveBeenCalledOnce();
  });

  test("caps repeated nearby presses at triple-click line selection", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    const selection = createSelectionState();
    const onMultiClick = vi.fn();
    const onOpenHyperlink = vi.fn();
    const app = createApp({
      selection,
      onMultiClick,
      onOpenHyperlink,
    });
    app.clickCount = 2;
    app.lastClickTime = 1_750;
    app.lastClickCol = 4;
    app.lastClickRow = 6;
    app.pendingHyperlinkTimer = setTimeout(onOpenHyperlink, 1_000);

    handleMouseEvent(app, mouse("press", 0, 5, 7));

    expect(app.clickCount).toBe(3);
    expect(app.pendingHyperlinkTimer).toBeNull();
    expect(onMultiClick).toHaveBeenCalledWith(4, 6, 3);
    expect(selection.anchor).toBeNull();

    vi.advanceTimersByTime(1_000);
    expect(onOpenHyperlink).not.toHaveBeenCalled();
  });

  test("supersedes a pending hyperlink open with the latest clicked link", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.stubEnv("TERM_PROGRAM", "");

    const onOpenHyperlink = vi.fn();
    const getHyperlinkAt = vi
      .fn<() => string>()
      .mockReturnValueOnce("https://agenc.test/first")
      .mockReturnValueOnce("https://agenc.test/second");
    const app = createApp({
      getHyperlinkAt,
      onOpenHyperlink,
    });

    handleMouseEvent(app, mouse("press", 0, 5, 7));
    handleMouseEvent(app, mouse("release", 0, 5, 7));
    expect(app.pendingHyperlinkTimer).not.toBeNull();

    vi.advanceTimersByTime(250);

    handleMouseEvent(app, mouse("press", 0, 20, 7));
    handleMouseEvent(app, mouse("release", 0, 20, 7));

    vi.advanceTimersByTime(500);

    expect(getHyperlinkAt).toHaveBeenCalledTimes(2);
    expect(onOpenHyperlink).toHaveBeenCalledOnce();
    expect(onOpenHyperlink).toHaveBeenCalledWith("https://agenc.test/second");
  });

  test("skips App hyperlink opening in VS Code terminals", () => {
    vi.useFakeTimers();
    vi.stubEnv("TERM_PROGRAM", "vscode");

    const getHyperlinkAt = vi.fn(() => "https://agenc.test/item");
    const onOpenHyperlink = vi.fn();
    const app = createApp({
      getHyperlinkAt,
      onOpenHyperlink,
    });

    handleMouseEvent(app, mouse("press", 0));
    handleMouseEvent(app, mouse("release", 0));
    vi.advanceTimersByTime(500);

    expect(getHyperlinkAt).toHaveBeenCalledWith(4, 6);
    expect(app.pendingHyperlinkTimer).toBeNull();
    expect(onOpenHyperlink).not.toHaveBeenCalled();
  });

  test("processes terminal focus transitions and restores focus on key input", () => {
    const selection = createSelectionState();
    selection.anchor = { col: 1, row: 1 };
    selection.focus = { col: 2, row: 2 };
    selection.isDragging = true;
    const onSelectionChange = vi.fn();
    const dispatchKeyboardEvent = vi.fn();
    const app = createApp({
      selection,
      onSelectionChange,
      dispatchKeyboardEvent,
    });
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    const onInput = vi.fn();
    app.internal_eventEmitter.on("terminalfocus", onFocus);
    app.internal_eventEmitter.on("terminalblur", onBlur);
    app.internal_eventEmitter.on("input", onInput);

    app.processInput(FOCUS_OUT);

    expect(getTerminalFocused()).toBe(false);
    expect(selection.isDragging).toBe(false);
    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(onBlur.mock.calls[0]?.[0]).toMatchObject({ type: "terminalblur" });
    expect(dispatchKeyboardEvent).not.toHaveBeenCalled();

    app.processInput(FOCUS_IN);
    expect(getTerminalFocused()).toBe(true);
    expect(onFocus.mock.calls[0]?.[0]).toMatchObject({ type: "terminalfocus" });

    app.handleTerminalFocus(false);
    app.processInput("a");

    expect(getTerminalFocused()).toBe(true);
    expect(onInput).toHaveBeenCalledOnce();
    expect(dispatchKeyboardEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "key",
        sequence: "a",
      }),
    );
  });

  test("handles terminal blur when no selection drag is active", () => {
    const selection = createSelectionState();
    const onSelectionChange = vi.fn();
    const app = createApp({
      selection,
      onSelectionChange,
    });

    app.processInput(FOCUS_OUT);

    expect(getTerminalFocused()).toBe(false);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  test("cancels delayed terminal identity probes after raw mode unmount", async () => {
    const stdin = ttyStream();
    const stdout = ttyStream();
    const app = createApp({
      stdin,
      stdout,
    });

    app.handleSetRawMode(true);
    app.componentWillUnmount();
    stdout.writes.length = 0;

    await flushImmediateTicks(60);

    expect(stdout.writes.join("")).toBe("");
    expect(stdout.write).toHaveBeenCalledWith(SHOW_CURSOR);
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(2, false);
  });

  test("renders children, error overview, and cursor declaration contexts", () => {
    const declareCursor = vi.fn();
    const app = createApp({
      children: "ready",
      onCursorDeclaration: declareCursor,
    });

    expect(app.render()).toMatchObject({
      type: expect.anything(),
      props: expect.objectContaining({
        value: {
          columns: 80,
          rows: 24,
        },
      }),
    });

    const error = new Error("render failed");
    app.state = { error };

    expect(deepestRenderedChild(app.render())).toMatchObject({
      props: {
        error,
      },
    });

    expect(() => cursorDeclarationValue(createApp().render())()).not.toThrow();
  });

  test("hides the cursor on tty mount unless accessibility mode keeps it visible", () => {
    const stdout = ttyStream();
    const app = createApp({ stdout });

    app.componentDidMount();
    expect(stdout.writes.join("")).toContain(HIDE_CURSOR);

    stdout.writes.length = 0;
    vi.stubEnv("AGENC_ACCESSIBILITY", "1");

    app.componentDidMount();
    expect(stdout.writes.join("")).not.toContain(HIDE_CURSOR);
  });

  test("rejects raw mode on unsupported stdin without mutating counters", () => {
    const provided = createApp({
      stdin: stream(),
    });
    const defaultInput = createApp({
      stdin: process.stdin as NodeJS.ReadStream,
    });

    expect(() => provided.handleSetRawMode(true)).toThrow("stdin provided to Ink");
    expect(provided.rawModeEnabledCount).toBe(0);
    expect(() => defaultInput.handleSetRawMode(true)).toThrow("current process.stdin");
    expect(defaultInput.rawModeEnabledCount).toBe(0);
  });

  test("uses data-mode stdin when opted in and cancels raw-start probes on disable", async () => {
    vi.stubEnv("AGENC_USE_DATA_STDIN", "1");

    const stdin = ttyStream();
    const stdout = ttyStream();
    const app = createApp({
      stdin,
      stdout,
    });

    app.handleSetRawMode(true);
    expect(app.stdinMode).toBe("data");
    expect(stdin.listeners("data")).toContain(app.handleDataChunk);
    expect(stdin.listeners("readable")).not.toContain(app.handleReadable);

    app.handleSetRawMode(false);
    const writesAfterDisable = stdout.writes.length;
    expect(app.rawModeEnabledCount).toBe(0);
    expect(app.terminalIdentityProbeImmediate).toBeNull();

    await flushImmediateTicks(60);

    expect(stdout.writes).toHaveLength(writesAfterDisable);
    expect(stdin.listeners("data")).not.toContain(app.handleDataChunk);
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(2, false);
  });

  test("enables extended key reporting when terminal support is explicitly opted in", () => {
    vi.stubEnv("AGENC_ENABLE_EXTENDED_KEYS", "1");
    env.terminal = "WezTerm";

    const stdin = ttyStream();
    const stdout = ttyStream();
    const app = createApp({
      stdin,
      stdout,
    });

    app.handleSetRawMode(true);

    expect(stdout.writes.join("")).toContain(ENABLE_KITTY_KEYBOARD);
    expect(stdout.writes.join("")).toContain(ENABLE_MODIFY_OTHER_KEYS);

    app.handleSetRawMode(false);
  });

  test("drains every raw mode owner on unmount, exit, and extra disable", () => {
    const stdin = ttyStream();
    const stdout = ttyStream();
    const app = createApp({
      stdin,
      stdout,
    });

    app.handleSetRawMode(true);
    app.handleSetRawMode(true);
    expect(app.rawModeEnabledCount).toBe(2);

    app.componentWillUnmount();

    expect(app.rawModeEnabledCount).toBe(0);
    expect(stdin.setRawMode).toHaveBeenCalledTimes(2);
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(2, false);
    expect(stdin.listeners("readable")).not.toContain(app.handleReadable);

    app.handleSetRawMode(false);
    expect(app.rawModeEnabledCount).toBe(0);
    expect(stdin.setRawMode).toHaveBeenCalledTimes(2);

    const onExit = vi.fn();
    const exitApp = createApp({
      stdin: ttyStream(),
      stdout: ttyStream(),
      onExit,
    });
    const exitError = new Error("exit");
    exitApp.handleSetRawMode(true);
    exitApp.handleSetRawMode(true);

    exitApp.handleExit(exitError);

    expect(exitApp.rawModeEnabledCount).toBe(0);
    expect(onExit).toHaveBeenCalledWith(exitError);
  });

  test("clears pending timers during unmount", () => {
    vi.useFakeTimers();

    const incompleteFlush = vi.fn();
    const hyperlinkOpen = vi.fn();
    const app = createApp();
    app.incompleteEscapeTimer = setTimeout(incompleteFlush, 100);
    app.pendingHyperlinkTimer = setTimeout(hyperlinkOpen, 100);

    app.componentWillUnmount();
    vi.advanceTimersByTime(100);

    expect(app.incompleteEscapeTimer).toBeNull();
    expect(app.pendingHyperlinkTimer).toBeNull();
    expect(incompleteFlush).not.toHaveBeenCalled();
    expect(hyperlinkOpen).not.toHaveBeenCalled();
  });

  test("flushes incomplete input only after buffered stdin has drained", () => {
    vi.useFakeTimers();

    const stdin = stream();
    Object.defineProperty(stdin, "readableLength", {
      configurable: true,
      value: 1,
    });
    const app = createApp({ stdin });
    const processInput = vi.spyOn(app, "processInput").mockImplementation(() => {});

    app.flushIncomplete();
    expect(processInput).not.toHaveBeenCalled();

    app.keyParseState = {
      mode: "NORMAL",
      incomplete: "\x1b",
      pasteBuffer: "",
    };
    app.flushIncomplete();
    expect(processInput).not.toHaveBeenCalled();
    expect(app.incompleteEscapeTimer).not.toBeNull();

    clearTimeout(app.incompleteEscapeTimer!);
    Object.defineProperty(stdin, "readableLength", {
      configurable: true,
      value: 0,
    });
    app.flushIncomplete();
    expect(processInput).toHaveBeenCalledWith(null);

    const forcedStdin = stream();
    Object.defineProperty(forcedStdin, "readableLength", {
      configurable: true,
      value: 1,
    });
    const forcedApp = createApp({ stdin: forcedStdin });
    const forcedProcessInput = vi.spyOn(forcedApp, "processInput").mockImplementation(() => {});
    forcedApp.keyParseState = {
      mode: "NORMAL",
      incomplete: "\x1b",
      pasteBuffer: "",
    };

    forcedApp.flushIncomplete();
    expect(forcedProcessInput).not.toHaveBeenCalled();

    forcedApp.flushIncomplete();
    expect(forcedProcessInput).toHaveBeenCalledWith(null);
  });

  test("clears stale incomplete timers before scheduling the next parser flush", () => {
    vi.useFakeTimers();

    const staleFlush = vi.fn();
    const app = createApp();
    app.incompleteEscapeTimer = setTimeout(staleFlush, 50);

    app.processInput("\x1b");
    vi.advanceTimersByTime(50);

    expect(staleFlush).not.toHaveBeenCalled();
    expect(app.incompleteEscapeTimer).toBeNull();

    const freshApp = createApp();
    freshApp.processInput("\x1b");
    expect(freshApp.incompleteEscapeTimer).not.toBeNull();
    clearTimeout(freshApp.incompleteEscapeTimer!);

    const pasteApp = createApp();
    pasteApp.processInput(`${PASTE_START}\x1b`);
    expect(pasteApp.keyParseState.mode).toBe("IN_PASTE");
    expect(pasteApp.incompleteEscapeTimer).not.toBeNull();
    clearTimeout(pasteApp.incompleteEscapeTimer!);
  });

  test("records input backpressure when batched key processing blocks", () => {
    const app = createApp();
    let performanceCalls = 0;
    vi.spyOn(performance, "now")
      .mockImplementation(() => performanceCalls++ === 0 ? 1_000 : 1_650);

    app.processInput("a");

    expect(getTuiBackpressureSnapshot()).toMatchObject({
      active: true,
      source: "input",
      durationMs: 650,
    });
  });

  test("recovers readable stdin after a resumed chunk throws", () => {
    vi.useFakeTimers();
    vi.setSystemTime(6_100);
    vi.stubEnv("DISABLE_ERROR_REPORTING", "1");

    const error = new Error("read failed");
    const stdin = throwingReadableHarness(error);
    const onStdinResume = vi.fn();
    const app = createApp({ stdin, onStdinResume });
    app.rawModeEnabledCount = 1;
    app.lastStdinTime = 1_000;

    app.handleReadable();

    expect(onStdinResume).toHaveBeenCalledOnce();
    expect(app.lastStdinTime).toBe(6_100);
    expect(stdin.listeners("readable")).toContain(app.handleReadable);
  });

  test("drains readable stdin chunks after a resume gap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(6_250);

    const stdin = readableChunksHarness(["a", Buffer.from("b").toString(), null]);
    const onStdinResume = vi.fn();
    const app = createApp({ stdin, onStdinResume });
    const processInput = vi.spyOn(app, "processInput").mockImplementation(() => {});
    app.lastStdinTime = 1_000;

    app.handleReadable();

    expect(onStdinResume).toHaveBeenCalledOnce();
    expect(app.lastStdinTime).toBe(6_250);
    expect(processInput).toHaveBeenNthCalledWith(1, "a");
    expect(processInput).toHaveBeenNthCalledWith(2, "b");
  });

  test("drains readable stdin without resume work for short input gaps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_250);

    const stdin = readableChunksHarness(["x", null]);
    const onStdinResume = vi.fn();
    const app = createApp({ stdin, onStdinResume });
    const processInput = vi.spyOn(app, "processInput").mockImplementation(() => {});
    app.lastStdinTime = 1_000;

    app.handleReadable();

    expect(onStdinResume).not.toHaveBeenCalled();
    expect(processInput).toHaveBeenCalledWith("x");
  });

  test("does not reattach readable or data listeners when recovery conditions are absent", () => {
    vi.stubEnv("DISABLE_ERROR_REPORTING", "1");

    const readableError = new Error("readable recovery skipped");
    const readable = throwingReadableHarness(readableError);
    const readableApp = createApp({ stdin: readable });
    readableApp.rawModeEnabledCount = 0;
    readableApp.handleReadable();
    expect(readable.addListener).not.toHaveBeenCalled();

    const data = stream();
    const dataApp = createApp({ stdin: data });
    vi.spyOn(dataApp, "processInput").mockImplementation(() => {
      throw new Error("data recovery skipped");
    });
    dataApp.rawModeEnabledCount = 0;
    dataApp.handleDataChunk("x");
    expect(data.listeners("data")).not.toContain(dataApp.handleDataChunk);
  });

  test("processes data chunks without resume work for short input gaps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_200);

    const onStdinResume = vi.fn();
    const app = createApp({ onStdinResume });
    const processInput = vi.spyOn(app, "processInput").mockImplementation(() => {});
    app.lastStdinTime = 1_000;

    app.handleDataChunk("x");

    expect(onStdinResume).not.toHaveBeenCalled();
    expect(processInput).toHaveBeenCalledWith("x");
  });

  test("exits on Ctrl-C only when configured to exit on Ctrl-C", () => {
    const exiting = createApp();
    const exit = vi.spyOn(exiting, "handleExit").mockImplementation(() => {});
    exiting.handleInput("\x03");
    expect(exit).toHaveBeenCalledOnce();

    const retained = createApp({ exitOnCtrlC: false });
    const retainedExit = vi.spyOn(retained, "handleExit").mockImplementation(() => {});
    retained.handleInput("\x03");
    expect(retainedExit).not.toHaveBeenCalled();

    const onExit = vi.fn();
    const directExit = createApp({ onExit });
    directExit.handleExit();
    expect(onExit).toHaveBeenCalledWith(undefined);
  });

  test("routes terminal responses, mouse input, and suspend keys through the batch processor", () => {
    const selection = createSelectionState();
    const onSelectionChange = vi.fn();
    const app = createApp({
      selection,
      onSelectionChange,
    });
    const onResponse = vi.spyOn(app.querier, "onResponse");
    const handleSuspend = vi.spyOn(app, "handleSuspend").mockImplementation(() => {});

    app.processInput("\x1bP>|AgenCTerm 1.0\x1b\\");
    app.processInput("\x1b[<0;5;7M");
    app.processInput("\x1a");

    expect(onResponse).toHaveBeenCalledWith({
      type: "xtversion",
      name: "AgenCTerm 1.0",
    });
    expect(selection.anchor).toEqual({ col: 4, row: 6 });
    expect(onSelectionChange).toHaveBeenCalled();
    expect(handleSuspend).toHaveBeenCalledOnce();
  });

  test("runs terminal identity probe completion handlers when the terminal replies", async () => {
    const stdin = ttyStream();
    const stdout = ttyStream();
    const app = createApp({
      stdin,
      stdout,
    });
    const send = vi.spyOn(app.querier, "send").mockResolvedValue({
      type: "xtversion",
      name: "AgenCTerm 1.0",
    } as never);
    const flush = vi.spyOn(app.querier, "flush").mockResolvedValue(undefined);

    app.handleSetRawMode(true);
    await flushImmediateTicks(1);
    await Promise.resolve();

    expect(send).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(app.terminalIdentityProbeImmediate).toBeNull();

    app.handleSetRawMode(false);
  });

  test("runs terminal identity probe fallback when the terminal ignores XTVERSION", async () => {
    const stdin = ttyStream();
    const stdout = ttyStream();
    const app = createApp({
      stdin,
      stdout,
    });
    vi.spyOn(app.querier, "send").mockResolvedValue(undefined);
    vi.spyOn(app.querier, "flush").mockResolvedValue(undefined);

    app.handleSetRawMode(true);
    await flushImmediateTicks(1);
    await Promise.resolve();

    expect(app.terminalIdentityProbeImmediate).toBeNull();

    app.handleSetRawMode(false);
  });

  test("suspends by draining raw mode and restores the exact owner count on SIGCONT", () => {
    const stdin = ttyStream();
    const stdout = ttyStream();
    const app = createApp({ stdin, stdout });
    const events: string[] = [];
    let resumeHandler: (() => void) | null = null;
    const processOn = vi.spyOn(process, "on").mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "SIGCONT") {
        resumeHandler = listener as () => void;
      }
      return process;
    }) as typeof process.on);
    const processRemove = vi.spyOn(process, "removeListener").mockImplementation(((event: string | symbol) => {
      if (event === "SIGCONT") {
        resumeHandler = null;
      }
      return process;
    }) as typeof process.removeListener);
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    app.internal_eventEmitter.on("suspend", () => events.push("suspend"));
    app.internal_eventEmitter.on("resume", () => events.push("resume"));

    app.handleSetRawMode(true);
    app.handleSetRawMode(true);
    stdout.writes.length = 0;

    app.handleSuspend();

    expect(app.rawModeEnabledCount).toBe(0);
    expect(stdout.writes.join("")).toContain(SHOW_CURSOR);
    expect(stdout.writes.join("")).toContain(DISABLE_MOUSE_TRACKING);
    expect(processOn).toHaveBeenCalledWith("SIGCONT", expect.any(Function));
    expect(processKill).toHaveBeenCalledWith(process.pid, "SIGSTOP");
    expect(events).toEqual(["suspend"]);

    resumeHandler?.();

    expect(app.rawModeEnabledCount).toBe(2);
    expect(stdout.writes.join("")).toContain(HIDE_CURSOR);
    expect(events).toEqual(["suspend", "resume"]);
    expect(processRemove).toHaveBeenCalledWith("SIGCONT", expect.any(Function));

    app.componentWillUnmount();
  });

  test("skips suspend when raw mode is unsupported", () => {
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const app = createApp();

    app.handleSuspend();

    expect(processKill).not.toHaveBeenCalled();
  });

  test("handles suspend and resume when stdout is not a TTY", () => {
    const stdin = ttyStream();
    const stdout = stream();
    const app = createApp({ stdin, stdout });
    let resumeHandler: (() => void) | null = null;
    vi.spyOn(process, "on").mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "SIGCONT") {
        resumeHandler = listener as () => void;
      }
      return process;
    }) as typeof process.on);
    vi.spyOn(process, "removeListener").mockImplementation(((event: string | symbol) => {
      if (event === "SIGCONT") {
        resumeHandler = null;
      }
      return process;
    }) as typeof process.removeListener);
    vi.spyOn(process, "kill").mockImplementation(() => true);

    app.handleSetRawMode(true);
    app.handleSuspend();
    resumeHandler?.();

    expect(stdout.write).not.toHaveBeenCalledWith(expect.stringContaining(SHOW_CURSOR));
    expect(app.rawModeEnabledCount).toBe(1);

    app.componentWillUnmount();
  });

  test("skips raw restoration on resume when stdin stops supporting raw mode", () => {
    const stdin = ttyStream();
    const stdout = ttyStream();
    const app = createApp({ stdin, stdout });
    let resumeHandler: (() => void) | null = null;
    vi.spyOn(process, "on").mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "SIGCONT") {
        resumeHandler = listener as () => void;
      }
      return process;
    }) as typeof process.on);
    vi.spyOn(process, "removeListener").mockImplementation(() => process);
    vi.spyOn(process, "kill").mockImplementation(() => true);

    app.handleSetRawMode(true);
    app.handleSuspend();
    stdin.isTTY = false;
    resumeHandler?.();

    expect(app.rawModeEnabledCount).toBe(0);
    expect(stdin.setRawMode).toHaveBeenCalledTimes(2);
  });

  test("keeps the cursor visible on accessible suspend resume", () => {
    vi.stubEnv("AGENC_ACCESSIBILITY", "1");

    const stdin = ttyStream();
    const stdout = ttyStream();
    const app = createApp({ stdin, stdout });
    let resumeHandler: (() => void) | null = null;
    vi.spyOn(process, "on").mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "SIGCONT") {
        resumeHandler = listener as () => void;
      }
      return process;
    }) as typeof process.on);
    vi.spyOn(process, "removeListener").mockImplementation(() => process);
    vi.spyOn(process, "kill").mockImplementation(() => true);

    app.handleSetRawMode(true);
    app.handleSuspend();
    stdout.writes.length = 0;
    resumeHandler?.();

    expect(stdout.writes.join("")).not.toContain(HIDE_CURSOR);

    app.componentWillUnmount();
  });

  test("finishes lost drags before fresh presses and skips hyperlink lookup for handled clicks", () => {
    const selection = createSelectionState();
    selection.anchor = { col: 1, row: 1 };
    selection.focus = { col: 2, row: 2 };
    selection.isDragging = true;
    const onSelectionChange = vi.fn();
    const onClickAt = vi.fn(() => true);
    const getHyperlinkAt = vi.fn(() => "https://agenc.test/ignored");
    const app = createApp({
      selection,
      onClickAt,
      getHyperlinkAt,
      onSelectionChange,
    });

    handleMouseEvent(app, mouse("press", 0, 10, 12));
    expect(selection.isDragging).toBe(true);
    expect(selection.anchor).toEqual({ col: 9, row: 11 });
    expect(onSelectionChange).toHaveBeenCalledTimes(2);

    handleMouseEvent(app, mouse("release", 0, 10, 12));

    expect(onClickAt).toHaveBeenCalledWith(9, 11);
    expect(getHyperlinkAt).not.toHaveBeenCalled();
  });

  test("does not dispatch clicks when release leaves an active selection", () => {
    const selection = createSelectionState();
    selection.anchor = { col: 1, row: 1 };
    selection.focus = { col: 3, row: 1 };
    const onClickAt = vi.fn(() => false);
    const app = createApp({
      selection,
      onClickAt,
    });

    handleMouseEvent(app, mouse("release", 0, 4, 2));

    expect(onClickAt).not.toHaveBeenCalled();
  });

  test("handles multi-clicks without a pending hyperlink timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    const onMultiClick = vi.fn();
    const app = createApp({ onMultiClick });
    app.clickCount = 1;
    app.lastClickTime = 1_900;
    app.lastClickCol = 4;
    app.lastClickRow = 6;

    handleMouseEvent(app, mouse("press", 0, 5, 7));

    expect(app.pendingHyperlinkTimer).toBeNull();
    expect(onMultiClick).toHaveBeenCalledWith(4, 6, 2);
  });
});
