import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import App, { handleMouseEvent } from "./App.js";
import type { ParsedMouse } from "../parse-keypress.js";
import { createSelectionState } from "../selection.js";

function stream() {
  const s = new PassThrough() as NodeJS.WriteStream & NodeJS.ReadStream;
  s.isTTY = false;
  s.write = vi.fn(() => true) as never;
  return s;
}

function mouse(action: ParsedMouse["action"], button: number): ParsedMouse {
  return {
    action,
    button,
    col: 5,
    kind: "mouse",
    row: 7,
    sequence: `mouse:${action}:${button}`,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Ink App mouse coverage", () => {
  test("cancels a pending hyperlink open when a second nearby press becomes a multi-click", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.stubEnv("TERM_PROGRAM", "");

    const selection = createSelectionState();
    const onSelectionChange = vi.fn();
    const onOpenHyperlink = vi.fn();
    const onMultiClick = vi.fn();
    const onClickAt = vi.fn(() => false);
    const getHyperlinkAt = vi.fn(() => "https://agenc.test/item");
    const app = new App({
      children: null,
      stdin: stream(),
      stdout: stream(),
      stderr: stream(),
      exitOnCtrlC: true,
      onExit: () => {},
      terminalColumns: 80,
      terminalRows: 24,
      selection,
      onSelectionChange,
      onClickAt,
      onHoverAt: () => {},
      getHyperlinkAt,
      onOpenHyperlink,
      onMultiClick,
      onSelectionDrag: () => {},
      dispatchKeyboardEvent: () => {},
    });

    handleMouseEvent(app, mouse("press", 0));
    handleMouseEvent(app, mouse("release", 0));

    expect(onClickAt).toHaveBeenCalledWith(4, 6);
    expect(getHyperlinkAt).toHaveBeenCalledWith(4, 6);
    expect(onOpenHyperlink).not.toHaveBeenCalled();
    expect(app.pendingHyperlinkTimer).not.toBeNull();

    vi.advanceTimersByTime(499);
    vi.setSystemTime(1_499);

    handleMouseEvent(app, mouse("press", 0));

    expect(app.pendingHyperlinkTimer).toBeNull();
    expect(onMultiClick).toHaveBeenCalledWith(4, 6, 2);

    vi.advanceTimersByTime(1);
    expect(onOpenHyperlink).not.toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
  });
});
