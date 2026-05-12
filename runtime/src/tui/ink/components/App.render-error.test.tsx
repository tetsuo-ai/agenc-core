import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";

import App from "./App.js";
import type { SelectionState } from "../selection.js";

function stream() {
  const s = new PassThrough() as NodeJS.WriteStream & NodeJS.ReadStream;
  s.isTTY = false;
  s.write = vi.fn(() => true) as never;
  return s;
}

function selection(): SelectionState {
  return {
    active: false,
    start: null,
    end: null,
    anchor: null,
    focus: null,
    mode: "char",
    isDragging: false,
  } as never;
}

describe("Ink App render error boundary", () => {
  test("keeps caught render errors visible until teardown", () => {
    const onExit = vi.fn();
    const error = new Error("render failed");
    const app = new App({
      children: null,
      stdin: stream(),
      stdout: stream(),
      stderr: stream(),
      exitOnCtrlC: true,
      onExit,
      terminalColumns: 80,
      terminalRows: 24,
      selection: selection(),
      onSelectionChange: () => {},
      onClickAt: () => false,
      onHoverAt: () => {},
      getHyperlinkAt: () => undefined,
      onOpenHyperlink: () => {},
      onMultiClick: () => {},
      onSelectionDrag: () => {},
      dispatchKeyboardEvent: () => {},
    });

    expect(App.getDerivedStateFromError(error)).toEqual({ error });
    app.componentDidCatch(error);
    expect(onExit).not.toHaveBeenCalled();

    app.componentWillUnmount();
    expect(onExit).toHaveBeenCalledWith(error);
  });
});
