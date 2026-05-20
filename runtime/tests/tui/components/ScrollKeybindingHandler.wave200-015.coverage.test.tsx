import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";

type SelectionState = {
  anchor?: { row: number };
  focus?: { row: number };
  isDragging?: boolean;
  scrolledOffAbove: string[];
  scrolledOffBelow: string[];
  scrolledOffAboveSW: boolean[];
  scrolledOffBelowSW: boolean[];
};

const harness = vi.hoisted(() => {
  const state = {
    addNotification: vi.fn(),
    keybindingCalls: [] as Array<Record<string, () => unknown>>,
    onSelectionChange: null as (() => void) | null,
    selectionState: null as SelectionState | null,
    unsubscribe: vi.fn(),
    selection: {
      clearSelection: vi.fn(),
      copySelection: vi.fn(() => ""),
      getState: vi.fn(() => state.selectionState),
      hasSelection: vi.fn(() => false),
      moveFocus: vi.fn(),
      captureScrolledRows: vi.fn(),
      shiftSelection: vi.fn(),
      shiftAnchor: vi.fn(),
      subscribe: vi.fn((callback: () => void) => {
        state.onSelectionChange = callback;
        return state.unsubscribe;
      }),
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
  useCopyOnSelect: vi.fn(),
  useSelectionBgColor: vi.fn(),
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
    isXtermJs: vi.fn(() => false),
  };
});

vi.mock("../ink/termio/osc.js", async () => {
  const actual =
    await vi.importActual<typeof import("../ink/termio/osc.js")>(
      "../ink/termio/osc.js",
    );
  return {
    ...actual,
    getClipboardPath: vi.fn(() => "native"),
  };
});

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: vi.fn(),
}));

vi.mock("../keybindings/useKeybinding.js", () => ({
  useKeybindings: (handlers: Record<string, () => unknown>) => {
    harness.keybindingCalls.push(handlers);
  },
}));

vi.mock("../ink.js", async () => {
  const actual = await vi.importActual<typeof import("../ink.js")>("../ink.js");
  return {
    ...actual,
    useInput: vi.fn(),
  };
});

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createStreams(): {
  stdin: TestStdin;
  stdout: PassThrough;
} {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough();
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns =
    80;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows =
    24;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY =
    true;
  stdout.resume();
  return { stdin, stdout };
}

function sleep(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSubscription(): Promise<() => void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (harness.onSelectionChange) return harness.onSelectionChange;
    await sleep(10);
  }
  throw new Error("Timed out waiting for drag-scroll subscription");
}

function makeScrollHandle() {
  const calls: Array<[string, number?]> = [];
  let pendingDelta = 0;
  let scrollTop = 5;

  return {
    calls,
    handle: {
      getPendingDelta: () => pendingDelta,
      getScrollHeight: () => 40,
      getScrollTop: () => scrollTop,
      getViewportHeight: () => 4,
      getViewportTop: () => 10,
      scrollBy: (amount: number) => {
        calls.push(["scrollBy", amount]);
        pendingDelta += amount;
      },
      scrollTo: (value: number) => {
        calls.push(["scrollTo", value]);
        scrollTop = value;
        pendingDelta = 0;
      },
      scrollToBottom: () => {
        calls.push(["scrollToBottom"]);
        scrollTop = 36;
        pendingDelta = 0;
      },
    },
  };
}

describe("ScrollKeybindingHandler drag-scroll coverage", () => {
  test("auto-scrolls dragging selections below the viewport and clears opposite-edge captured rows", async () => {
    harness.addNotification.mockClear();
    harness.keybindingCalls.length = 0;
    harness.onSelectionChange = null;
    harness.selectionState = {
      anchor: { row: 12 },
      focus: { row: 15 },
      isDragging: true,
      scrolledOffAbove: [],
      scrolledOffBelow: [],
      scrolledOffAboveSW: [],
      scrolledOffBelowSW: [],
    };
    harness.selection.captureScrolledRows.mockClear();
    harness.selection.shiftAnchor.mockClear();
    harness.selection.subscribe.mockClear();
    harness.unsubscribe.mockClear();

    const { ScrollKeybindingHandler } = await import("./ScrollKeybindingHandler.js");
    const scrollBox = makeScrollHandle();
    const onScroll = vi.fn();
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <ScrollKeybindingHandler
          isActive
          onScroll={onScroll}
          scrollRef={{ current: scrollBox.handle as never }}
        />,
      );
      const notifySelectionChanged = await waitForSubscription();

      notifySelectionChanged();

      expect(harness.selection.captureScrolledRows).toHaveBeenCalledWith(
        10,
        11,
        "above",
      );
      expect(harness.selection.shiftAnchor).toHaveBeenCalledWith(-2, 10, 13);
      expect(scrollBox.calls).toEqual([["scrollBy", 2]]);
      expect(onScroll).toHaveBeenCalledWith(false, scrollBox.handle);

      harness.selectionState.focus = { row: 8 };
      harness.selectionState.scrolledOffAbove = ["captured"];
      harness.selectionState.scrolledOffBelow = [];
      harness.selectionState.scrolledOffAboveSW = [false];
      harness.selectionState.scrolledOffBelowSW = [];

      notifySelectionChanged();

      expect(harness.selectionState.scrolledOffAbove).toEqual([]);
      expect(harness.selectionState.scrolledOffBelow).toEqual([]);
      expect(harness.selectionState.scrolledOffAboveSW).toEqual([]);
      expect(harness.selectionState.scrolledOffBelowSW).toEqual([]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
