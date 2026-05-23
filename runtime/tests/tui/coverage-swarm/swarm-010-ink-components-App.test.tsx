import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import App, { handleMouseEvent } from "../../../src/tui/ink/components/App.js";
import type { ParsedMouse } from "../../../src/tui/ink/parse-keypress.js";
import { createSelectionState } from "../../../src/tui/ink/selection.js";
import { SHOW_CURSOR } from "../../../src/tui/ink/termio/dec.js";
import { FOCUS_IN, FOCUS_OUT } from "../../../src/tui/ink/termio/csi.js";
import {
  getTerminalFocused,
  resetTerminalFocusState,
} from "../../../src/tui/ink/terminal-focus-state.js";

type TestStream = NodeJS.ReadStream & NodeJS.WriteStream;
type TestTtyStream = TestStream & {
  isRaw?: boolean;
  writes: string[];
  ref: ReturnType<typeof vi.fn>;
  setRawMode: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};
type AppProps = ConstructorParameters<typeof App>[0];

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
});
