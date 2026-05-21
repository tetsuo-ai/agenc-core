import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";

type KeybindingCall = {
  handlers: Record<string, () => unknown>;
  options: { context: string; isActive: boolean };
};

type InputEvent = { stopImmediatePropagation: () => void };
type InputCall = {
  handler: (
    input: string,
    key: Record<string, boolean>,
    event: InputEvent,
  ) => void;
  options: { isActive: boolean };
};

type ScrollBoxMock = {
  calls: Array<[string, number?]>;
  handle: {
    getPendingDelta: () => number;
    getScrollHeight: () => number;
    getScrollTop: () => number;
    getViewportHeight: () => number;
    getViewportTop: () => number;
    scrollBy: (amount: number) => void;
    scrollTo: (value: number) => void;
    scrollToBottom: () => void;
  };
};

const harness = vi.hoisted(() => {
  const state = {
    addNotification: vi.fn(),
    getClipboardPath: vi.fn(() => "native"),
    inputCalls: [] as InputCall[],
    isXtermJs: vi.fn(() => false),
    keybindingCalls: [] as KeybindingCall[],
    logForDebugging: vi.fn(),
    selectionState: null as unknown,
    useCopyOnSelect: vi.fn(),
    useSelectionBgColor: vi.fn(),
    selection: {
      clearSelection: vi.fn(),
      copySelection: vi.fn(() => ""),
      getState: vi.fn(() => state.selectionState),
      hasSelection: vi.fn(() => false),
      moveFocus: vi.fn(),
      captureScrolledRows: vi.fn(),
      shiftSelection: vi.fn(),
      shiftAnchor: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
  };

  return state;
});

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../context/notifications", () => ({
  useNotifications: () => ({
    addNotification: harness.addNotification,
  }),
}));

vi.mock("../hooks/useCopyOnSelect", () => ({
  useCopyOnSelect: harness.useCopyOnSelect,
  useSelectionBgColor: harness.useSelectionBgColor,
}));

vi.mock("../ink/hooks/use-selection.js", () => ({
  useSelection: () => harness.selection,
}));

vi.mock("../ink/terminal.js", async () => {
  const actual =
    await vi.importActual<typeof import("../ink/terminal.js")>(
      "../ink/terminal.js",
    );
  return {
    ...actual,
    isXtermJs: harness.isXtermJs,
  };
});

vi.mock("../ink/termio/osc.js", () => ({
  getClipboardPath: harness.getClipboardPath,
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: harness.logForDebugging,
}));

vi.mock("../keybindings/useKeybinding.js", () => ({
  useKeybindings: (
    handlers: Record<string, () => unknown>,
    options: { context: string; isActive: boolean },
  ) => {
    harness.keybindingCalls.push({ handlers, options });
  },
}));

vi.mock("../ink.js", async () => {
  const actual = await vi.importActual<typeof import("../ink.js")>("../ink.js");
  return {
    ...actual,
    useInput: (
      handler: InputCall["handler"],
      options: InputCall["options"],
    ) => {
      harness.inputCalls.push({ handler, options });
    },
  };
});

function makeScrollBox({
  pendingDelta = 0,
  scrollHeight = 100,
  scrollTop = 10,
  viewportHeight = 20,
  viewportTop = 2,
} = {}): ScrollBoxMock {
  const calls: Array<[string, number?]> = [];
  let pending = pendingDelta;
  let top = scrollTop;

  const handle = {
    getPendingDelta: () => pending,
    getScrollHeight: () => scrollHeight,
    getScrollTop: () => top,
    getViewportHeight: () => viewportHeight,
    getViewportTop: () => viewportTop,
    scrollBy: (amount: number) => {
      calls.push(["scrollBy", amount]);
      pending += amount;
    },
    scrollTo: (value: number) => {
      calls.push(["scrollTo", value]);
      top = value;
      pending = 0;
    },
    scrollToBottom: () => {
      calls.push(["scrollToBottom"]);
      top = Math.max(0, scrollHeight - viewportHeight);
      pending = 0;
    },
  };

  return { calls, handle };
}

function key(overrides: Record<string, boolean> = {}) {
  return {
    ctrl: false,
    downArrow: false,
    end: false,
    escape: false,
    home: false,
    leftArrow: false,
    meta: false,
    rightArrow: false,
    shift: false,
    upArrow: false,
    ...overrides,
  };
}

function event(): InputEvent {
  return { stopImmediatePropagation: vi.fn() };
}

async function renderHandler({
  isActive = true,
  isModal = false,
  onScroll = vi.fn(),
  scrollBox = makeScrollBox(),
  scrollRefCurrent = scrollBox.handle as ScrollBoxMock["handle"] | null,
} = {}) {
  const { ScrollKeybindingHandler } = await import(
    "../components/ScrollKeybindingHandler.js"
  );

  await renderToString(
    <ScrollKeybindingHandler
      scrollRef={{ current: scrollRefCurrent as never }}
      isActive={isActive}
      isModal={isModal}
      onScroll={onScroll}
    />,
    80,
  );

  return {
    customBindings: harness.keybindingCalls[1]?.handlers ?? {},
    inputCalls: harness.inputCalls,
    mainBindings: harness.keybindingCalls[0]?.handlers ?? {},
    onScroll,
    scrollBox,
  };
}

describe("ScrollKeybindingHandler coverage swarm row 023", () => {
  beforeEach(() => {
    harness.addNotification.mockClear();
    harness.getClipboardPath.mockClear();
    harness.getClipboardPath.mockReturnValue("native");
    harness.inputCalls.length = 0;
    harness.isXtermJs.mockClear();
    harness.isXtermJs.mockReturnValue(false);
    harness.keybindingCalls.length = 0;
    harness.logForDebugging.mockClear();
    harness.selectionState = null;
    harness.useCopyOnSelect.mockClear();
    harness.useSelectionBgColor.mockClear();

    harness.selection.clearSelection.mockClear();
    harness.selection.copySelection.mockClear();
    harness.selection.copySelection.mockReturnValue("");
    harness.selection.getState.mockClear();
    harness.selection.hasSelection.mockClear();
    harness.selection.hasSelection.mockReturnValue(false);
    harness.selection.moveFocus.mockClear();
    harness.selection.captureScrolledRows.mockClear();
    harness.selection.shiftSelection.mockClear();
    harness.selection.shiftAnchor.mockClear();
    harness.selection.subscribe.mockClear();
    harness.selection.subscribe.mockReturnValue(vi.fn());
  });

  test("no-ops scroll actions that require a missing scroll ref", async () => {
    const { customBindings, mainBindings, onScroll } = await renderHandler({
      scrollRefCurrent: null,
    });

    mainBindings["scroll:pageUp"]?.();
    mainBindings["scroll:pageDown"]?.();
    mainBindings["scroll:top"]?.();
    mainBindings["scroll:bottom"]?.();
    customBindings["scroll:halfPageUp"]?.();
    customBindings["scroll:halfPageDown"]?.();
    customBindings["scroll:fullPageUp"]?.();
    customBindings["scroll:fullPageDown"]?.();

    expect(onScroll).not.toHaveBeenCalled();
    expect(harness.selection.captureScrolledRows).not.toHaveBeenCalled();
    expect(harness.selection.shiftSelection).not.toHaveBeenCalled();
  });

  test("scrolls wheel-down within content and reports non-sticky state", async () => {
    const scrollBox = makeScrollBox({
      scrollHeight: 100,
      scrollTop: 20,
      viewportHeight: 20,
    });
    const { mainBindings, onScroll } = await renderHandler({ scrollBox });

    mainBindings["scroll:lineDown"]?.();

    expect(harness.selection.clearSelection).toHaveBeenCalledOnce();
    expect(scrollBox.calls).toEqual([["scrollBy", 1]]);
    expect(onScroll).toHaveBeenLastCalledWith(false, scrollBox.handle);
    expect(harness.logForDebugging).toHaveBeenCalledWith(
      expect.stringContaining("wheel accel: window"),
    );
  });

  test("does not translate selections outside the scroll viewport", async () => {
    const scrollBox = makeScrollBox({
      scrollTop: 10,
      viewportHeight: 10,
      viewportTop: 5,
    });
    const { mainBindings } = await renderHandler({ scrollBox });

    harness.selectionState = {
      anchor: { row: 4 },
      focus: { row: 7 },
    };
    mainBindings["scroll:pageDown"]?.();

    harness.selectionState = {
      anchor: { row: 7 },
      focus: { row: 20 },
    };
    mainBindings["scroll:pageDown"]?.();

    expect(harness.selection.captureScrolledRows).not.toHaveBeenCalled();
    expect(harness.selection.shiftSelection).not.toHaveBeenCalled();
    expect(scrollBox.calls).toEqual([["scrollTo", 15], ["scrollTo", 20]]);
  });

  test("selection input passes through when absent and preserves meta navigation", async () => {
    const { inputCalls } = await renderHandler();
    const selectionInput = inputCalls[1];

    const absent = event();
    selectionInput?.handler("x", key(), absent);

    expect(harness.selection.clearSelection).not.toHaveBeenCalled();
    expect(absent.stopImmediatePropagation).not.toHaveBeenCalled();

    harness.selection.hasSelection.mockReturnValue(true);

    const metaNav = event();
    selectionInput?.handler("", key({ meta: true, rightArrow: true }), metaNav);

    expect(harness.selection.moveFocus).not.toHaveBeenCalled();
    expect(harness.selection.clearSelection).not.toHaveBeenCalled();
    expect(metaNav.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  test("copy-on-select callback uses the same clipboard notification path", async () => {
    await renderHandler();

    const copiedCallback = harness.useCopyOnSelect.mock.calls[0]?.[2] as
      | ((text: string) => void)
      | undefined;
    copiedCallback?.("copied from drag");

    expect(harness.addNotification).toHaveBeenCalledWith({
      key: "selection-copied",
      text: "copied 16 chars to clipboard",
      color: "suggestion",
      priority: "immediate",
      timeoutMs: 2000,
    });
  });
});
