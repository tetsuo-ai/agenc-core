import { afterEach, describe, expect, test, vi } from "vitest";

import type { Key } from "../../ink.js";
import {
  clampPromptTextInputColumns,
  formatVimModeIndicator,
  getNewlineInstructions,
  isNonSpacePrintable,
  isVimModeEnabled,
  pasteReferenceLineThreshold,
} from "./utils.js";

const mocks = vi.hoisted(() => ({
  config: {
    editorMode: "default",
    hasUsedBackslashReturn: false,
    shiftEnterKeyBindingInstalled: false,
    tui: {} as { vimMode?: boolean },
  },
  env: {
    terminal: "xterm",
  },
}));

vi.mock("../../../utils/config.js", () => ({
  getGlobalConfig: () => mocks.config,
}));

vi.mock("../../../utils/env.js", () => ({
  env: mocks.env,
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function key(overrides: Partial<Key> = {}): Key {
  return {
    ctrl: false,
    meta: false,
    escape: false,
    return: false,
    tab: false,
    backspace: false,
    delete: false,
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    home: false,
    end: false,
    ...overrides,
  } as Key;
}

afterEach(() => {
  mocks.config.editorMode = "default";
  mocks.config.hasUsedBackslashReturn = false;
  mocks.config.shiftEnterKeyBindingInstalled = false;
  mocks.config.tui = {};
  mocks.env.terminal = "xterm";
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

describe("PromptInput utils", () => {
  test("resolves vim mode from explicit TUI config before editor mode", () => {
    expect(
      isVimModeEnabled({
        editorMode: "vim",
        tui: { vimMode: false },
      } as never),
    ).toBe(false);
    expect(
      isVimModeEnabled({
        editorMode: "default",
        tui: { vimMode: true },
      } as never),
    ).toBe(true);
    expect(isVimModeEnabled({ editorMode: "vim" } as never)).toBe(true);
    expect(isVimModeEnabled({ editorMode: "default" } as never)).toBe(false);
  });

  test("formats vim mode indicators only when a mode is active", () => {
    expect(formatVimModeIndicator(undefined)).toBeNull();
    expect(formatVimModeIndicator("INSERT")).toBe("-- INSERT --");
  });

  test("returns newline instructions for terminal and config states", () => {
    mocks.env.terminal = "Apple_Terminal";
    setPlatform("darwin");
    expect(getNewlineInstructions()).toBe("shift + ⏎ for newline");

    mocks.env.terminal = "xterm";
    setPlatform("linux");
    mocks.config.shiftEnterKeyBindingInstalled = true;
    expect(getNewlineInstructions()).toBe("shift + ⏎ for newline");

    mocks.config.shiftEnterKeyBindingInstalled = false;
    mocks.config.hasUsedBackslashReturn = true;
    expect(getNewlineInstructions()).toBe("\\⏎ for newline");

    mocks.config.hasUsedBackslashReturn = false;
    expect(getNewlineInstructions()).toBe(
      "backslash (\\) + return (⏎) for newline",
    );
  });

  test("clamps prompt input columns to the editable area", () => {
    expect(clampPromptTextInputColumns(0)).toBe(0);
    expect(clampPromptTextInputColumns(3)).toBe(0);
    expect(clampPromptTextInputColumns(4)).toBe(0);
    expect(clampPromptTextInputColumns(5)).toBe(0);
    expect(clampPromptTextInputColumns(10)).toBe(5);
    expect(clampPromptTextInputColumns(80)).toBe(75);
  });

  test("limits paste reference rows to one or two lines", () => {
    expect(pasteReferenceLineThreshold(0)).toBe(1);
    expect(pasteReferenceLineThreshold(5)).toBe(1);
    expect(pasteReferenceLineThreshold(9)).toBe(1);
    expect(pasteReferenceLineThreshold(10)).toBe(1);
    expect(pasteReferenceLineThreshold(11)).toBe(1);
    expect(pasteReferenceLineThreshold(12)).toBe(2);
    expect(pasteReferenceLineThreshold(24)).toBe(2);
    expect(pasteReferenceLineThreshold(40)).toBe(2);
  });

  test("rejects control/navigation keys as non-printable", () => {
    for (const flag of [
      "ctrl",
      "meta",
      "escape",
      "return",
      "tab",
      "backspace",
      "delete",
      "upArrow",
      "downArrow",
      "leftArrow",
      "rightArrow",
      "pageUp",
      "pageDown",
      "home",
      "end",
    ] as const) {
      expect(isNonSpacePrintable("x", key({ [flag]: true }))).toBe(false);
    }
  });

  test("recognizes normal non-space printable input", () => {
    expect(isNonSpacePrintable("", key())).toBe(false);
    expect(isNonSpacePrintable(" x", key())).toBe(false);
    expect(isNonSpacePrintable("\x1b[200~paste", key())).toBe(false);
    expect(isNonSpacePrintable("x", key())).toBe(true);
  });
});
