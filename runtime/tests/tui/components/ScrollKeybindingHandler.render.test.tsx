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

type SelectionMock = {
  getState: ReturnType<typeof vi.fn>;
  clearSelection: ReturnType<typeof vi.fn>;
  hasSelection: ReturnType<typeof vi.fn>;
  copySelection: ReturnType<typeof vi.fn>;
  moveFocus: ReturnType<typeof vi.fn>;
  captureScrolledRows: ReturnType<typeof vi.fn>;
  shiftSelection: ReturnType<typeof vi.fn>;
  shiftAnchor: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
};

const harness = vi.hoisted(() => {
  const state = {
    keybindingCalls: [] as KeybindingCall[],
    inputCalls: [] as InputCall[],
    selectionState: null as unknown,
    unsubscribe: vi.fn(),
    addNotification: vi.fn(),
    getClipboardPath: vi.fn(() => "native"),
    isXtermJs: vi.fn(() => false),
    logForDebugging: vi.fn(),
    useCopyOnSelect: vi.fn(),
    useSelectionBgColor: vi.fn(),
    selection: undefined as unknown as SelectionMock,
  };

  state.selection = {
    getState: vi.fn(() => state.selectionState),
    clearSelection: vi.fn(),
    hasSelection: vi.fn(() => false),
    copySelection: vi.fn(() => ""),
    moveFocus: vi.fn(),
    captureScrolledRows: vi.fn(),
    shiftSelection: vi.fn(),
    shiftAnchor: vi.fn(),
    subscribe: vi.fn(() => state.unsubscribe),
  };

  return state;
});

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
  const actual = await vi.importActual<typeof import("../ink/terminal.js")>(
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
} = {}) {
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
} = {}) {
  const { ScrollKeybindingHandler } = await import("./ScrollKeybindingHandler.js");

  await renderToString(
    <ScrollKeybindingHandler
      scrollRef={{ current: scrollBox.handle as never }}
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

describe("ScrollKeybindingHandler keybinding registration", () => {
  beforeEach(() => {
    harness.keybindingCalls.length = 0;
    harness.inputCalls.length = 0;
    harness.selectionState = null;
    harness.unsubscribe.mockClear();
    harness.addNotification.mockClear();
    harness.getClipboardPath.mockClear();
    harness.getClipboardPath.mockReturnValue("native");
    harness.isXtermJs.mockClear();
    harness.isXtermJs.mockReturnValue(false);
    harness.logForDebugging.mockClear();
    harness.useCopyOnSelect.mockClear();
    harness.useSelectionBgColor.mockClear();

    harness.selection.getState.mockClear();
    harness.selection.clearSelection.mockClear();
    harness.selection.hasSelection.mockClear();
    harness.selection.hasSelection.mockReturnValue(false);
    harness.selection.copySelection.mockClear();
    harness.selection.copySelection.mockReturnValue("");
    harness.selection.moveFocus.mockClear();
    harness.selection.captureScrolledRows.mockClear();
    harness.selection.shiftSelection.mockClear();
    harness.selection.shiftAnchor.mockClear();
    harness.selection.subscribe.mockClear();
    harness.selection.subscribe.mockReturnValue(harness.unsubscribe);
  });

  test("translates active selections for page-up and page-down keybindings", async () => {
    harness.selectionState = {
      anchor: { row: 3 },
      focus: { row: 5 },
    };
    const scrollBox = makeScrollBox({
      scrollTop: 10,
      viewportHeight: 10,
      viewportTop: 2,
    });
    const { mainBindings, onScroll } = await renderHandler({ scrollBox });

    mainBindings["scroll:pageDown"]?.();

    expect(harness.selection.captureScrolledRows).toHaveBeenCalledWith(
      2,
      6,
      "above",
    );
    expect(harness.selection.shiftSelection).toHaveBeenCalledWith(-5, 2, 11);
    expect(scrollBox.calls).toEqual([["scrollTo", 15]]);
    expect(onScroll).toHaveBeenLastCalledWith(false, scrollBox.handle);

    harness.selection.captureScrolledRows.mockClear();
    harness.selection.shiftSelection.mockClear();
    scrollBox.calls.length = 0;

    mainBindings["scroll:pageUp"]?.();

    expect(harness.selection.captureScrolledRows).toHaveBeenCalledWith(
      7,
      11,
      "below",
    );
    expect(harness.selection.shiftSelection).toHaveBeenCalledWith(5, 2, 11);
    expect(scrollBox.calls).toEqual([["scrollTo", 10]]);
    expect(onScroll).toHaveBeenLastCalledWith(false, scrollBox.handle);
  });

  test("lets wheel keybindings fall through when content fits", async () => {
    const scrollBox = makeScrollBox({
      scrollHeight: 10,
      viewportHeight: 20,
    });
    const { mainBindings, onScroll } = await renderHandler({ scrollBox });

    expect(mainBindings["scroll:lineDown"]?.()).toBe(false);

    expect(harness.selection.clearSelection).toHaveBeenCalledOnce();
    expect(scrollBox.calls).toEqual([]);
    expect(onScroll).not.toHaveBeenCalled();
  });

  test("reports sticky bottom from wheel-down and clamps wheel-up at top", async () => {
    const downBox = makeScrollBox({
      scrollHeight: 100,
      scrollTop: 79,
      viewportHeight: 20,
    });
    const first = await renderHandler({ scrollBox: downBox });

    first.mainBindings["scroll:lineDown"]?.();

    expect(downBox.calls).toEqual([["scrollToBottom"]]);
    expect(first.onScroll).toHaveBeenLastCalledWith(true, downBox.handle);
    expect(harness.logForDebugging).toHaveBeenCalledWith(
      expect.stringContaining("wheel accel: window"),
    );

    harness.keybindingCalls.length = 0;
    harness.inputCalls.length = 0;
    harness.selection.clearSelection.mockClear();

    const upBox = makeScrollBox({
      scrollHeight: 100,
      scrollTop: 0,
      viewportHeight: 20,
    });
    const second = await renderHandler({ scrollBox: upBox });

    second.mainBindings["scroll:lineUp"]?.();

    expect(harness.selection.clearSelection).toHaveBeenCalledOnce();
    expect(upBox.calls).toEqual([["scrollTo", 0]]);
    expect(second.onScroll).toHaveBeenLastCalledWith(false, upBox.handle);
  });

  test("handles custom half-page and full-page keybinding routes", async () => {
    const scrollBox = makeScrollBox({
      scrollTop: 20,
      viewportHeight: 9,
    });
    const { customBindings, onScroll } = await renderHandler({ scrollBox });

    customBindings["scroll:halfPageDown"]?.();
    expect(scrollBox.calls).toEqual([["scrollTo", 24]]);
    expect(onScroll).toHaveBeenLastCalledWith(false, scrollBox.handle);

    scrollBox.calls.length = 0;

    customBindings["scroll:fullPageUp"]?.();
    expect(scrollBox.calls).toEqual([["scrollTo", 15]]);
    expect(onScroll).toHaveBeenLastCalledWith(false, scrollBox.handle);
  });

  test("runs absolute scroll and copy keybindings", async () => {
    const scrollBox = makeScrollBox({
      pendingDelta: 3,
      scrollHeight: 100,
      scrollTop: 20,
      viewportHeight: 20,
    });
    const { mainBindings, onScroll } = await renderHandler({ scrollBox });

    mainBindings["scroll:bottom"]?.();
    expect(scrollBox.calls).toEqual([["scrollTo", 80], ["scrollToBottom"]]);
    expect(onScroll).toHaveBeenLastCalledWith(true, scrollBox.handle);

    scrollBox.calls.length = 0;

    mainBindings["scroll:top"]?.();
    expect(scrollBox.calls).toEqual([["scrollTo", 0]]);
    expect(onScroll).toHaveBeenLastCalledWith(false, scrollBox.handle);

    harness.selection.copySelection.mockReturnValue("abc");
    harness.getClipboardPath.mockReturnValue("tmux-buffer");

    mainBindings["selection:copy"]?.();

    expect(harness.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "selection-copied",
        text: expect.stringContaining("tmux buffer"),
        timeoutMs: 4000,
      }),
    );
  });

  test("consumes modal pager input only when it maps to a scroll action", async () => {
    const scrollBox = makeScrollBox({ scrollTop: 10 });
    const { inputCalls, onScroll } = await renderHandler({
      isModal: true,
      scrollBox,
    });
    const modalInput = inputCalls[0];

    expect(modalInput?.options).toEqual({ isActive: true });

    const consumed = event();
    modalInput?.handler("j", key(), consumed);

    expect(scrollBox.calls).toEqual([["scrollTo", 11]]);
    expect(onScroll).toHaveBeenLastCalledWith(false, scrollBox.handle);
    expect(consumed.stopImmediatePropagation).toHaveBeenCalledOnce();

    const passthrough = event();
    modalInput?.handler("x", key(), passthrough);

    expect(passthrough.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  test("handles selection escape, copy, focus extension, and clear input paths", async () => {
    const { inputCalls } = await renderHandler();
    const selectionInput = inputCalls[1];
    harness.selection.hasSelection.mockReturnValue(true);

    const escape = event();
    selectionInput?.handler("", key({ escape: true }), escape);
    expect(harness.selection.clearSelection).toHaveBeenCalledOnce();
    expect(escape.stopImmediatePropagation).toHaveBeenCalledOnce();

    harness.selection.clearSelection.mockClear();
    harness.selection.copySelection.mockReturnValue("copied");

    const copy = event();
    selectionInput?.handler("c", key({ ctrl: true }), copy);
    expect(harness.selection.copySelection).toHaveBeenCalledOnce();
    expect(harness.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ text: "copied 6 chars to clipboard" }),
    );
    expect(copy.stopImmediatePropagation).toHaveBeenCalledOnce();

    const extend = event();
    selectionInput?.handler("", key({ rightArrow: true, shift: true }), extend);
    expect(harness.selection.moveFocus).toHaveBeenCalledWith("right");
    expect(extend.stopImmediatePropagation).toHaveBeenCalledOnce();

    harness.selection.clearSelection.mockClear();
    const ordinary = event();
    selectionInput?.handler("x", key(), ordinary);

    expect(harness.selection.clearSelection).toHaveBeenCalledOnce();
    expect(ordinary.stopImmediatePropagation).not.toHaveBeenCalled();
  });
});
