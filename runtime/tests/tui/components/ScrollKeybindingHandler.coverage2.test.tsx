import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";

type KeybindingCall = {
  handlers: Record<string, () => unknown>;
  options: { context: string; isActive: boolean };
};

const harness = vi.hoisted(() => {
  const state = {
    addNotification: vi.fn(),
    getClipboardPath: vi.fn(() => "osc52"),
    keybindingCalls: [] as KeybindingCall[],
    selection: {
      clearSelection: vi.fn(),
      copySelection: vi.fn(() => "terminal copy"),
      getState: vi.fn(() => null),
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

vi.mock("../ink/termio/osc.js", () => ({
  getClipboardPath: harness.getClipboardPath,
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: vi.fn(),
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
    useInput: vi.fn(),
  };
});

describe("ScrollKeybindingHandler copy notification coverage", () => {
  beforeEach(() => {
    harness.addNotification.mockClear();
    harness.getClipboardPath.mockClear();
    harness.getClipboardPath.mockReturnValue("osc52");
    harness.keybindingCalls.length = 0;
    harness.selection.copySelection.mockClear();
    harness.selection.copySelection.mockReturnValue("terminal copy");
  });

  test("reports OSC 52 clipboard delivery when copying a selection", async () => {
    const { ScrollKeybindingHandler } = await import("./ScrollKeybindingHandler.js");

    await renderToString(
      <ScrollKeybindingHandler
        isActive
        scrollRef={{ current: null }}
      />,
      80,
    );

    harness.keybindingCalls[0]?.handlers["selection:copy"]?.();

    expect(harness.selection.copySelection).toHaveBeenCalledOnce();
    expect(harness.addNotification).toHaveBeenCalledWith({
      key: "selection-copied",
      text: "sent 13 chars via OSC 52 · check terminal clipboard settings if paste fails",
      color: "suggestion",
      priority: "immediate",
      timeoutMs: 4000,
    });
  });
});
