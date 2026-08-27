import { afterEach, describe, expect, test, vi } from "vitest";

import type { Key } from "../../ink.js";
import {
  clampPromptTextInputColumns,
  clampWorkbenchPromptTextInputColumns,
  formatVimModeIndicator,
  getNewlineInstructions,
  isNonSpacePrintable,
  isVimModeEnabled,
  pasteReferenceLineThreshold,
} from "./utils.js";

const mocks = vi.hoisted(() => ({
  config: {
    hasUsedBackslashReturn: false,
    shiftEnterKeyBindingInstalled: false,
  },
  operatorConfig: { tui: {} as { vimMode?: boolean } },
  env: {
    terminal: "xterm",
  },
}));

vi.mock("../../../utils/config.js", () => ({
  getRuntimeState: () => mocks.config,
}));

vi.mock("../../../utils/settings/canonicalAuthority.js", () => ({
  getCanonicalSettingsAuthority: () => ({
    current: () => mocks.operatorConfig,
  }),
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
  mocks.config.hasUsedBackslashReturn = false;
  mocks.config.shiftEnterKeyBindingInstalled = false;
  mocks.operatorConfig.tui = {};
  mocks.env.terminal = "xterm";
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

describe("PromptInput utils", () => {
  test("uses tui.vimMode as the sole Vim-input authority", () => {
    expect(isVimModeEnabled({ tui: { vimMode: false } })).toBe(false);
    expect(isVimModeEnabled({ tui: { vimMode: true } })).toBe(true);
    expect(isVimModeEnabled({})).toBe(false);

    mocks.operatorConfig.tui = { vimMode: true };
    expect(isVimModeEnabled()).toBe(true);
  });

  test("formats vim mode indicators only when a mode is active", () => {
    expect(formatVimModeIndicator(undefined)).toBeNull();
    expect(formatVimModeIndicator("INSERT")).toBe("-- INSERT --");
  });

  test("returns newline instructions for terminal and config states", () => {
    mocks.env.terminal = "Apple_Terminal";
    setPlatform("darwin");
    expect(getNewlineInstructions(mocks.config)).toBe("shift + ⏎ for newline");

    mocks.env.terminal = "xterm";
    setPlatform("linux");
    mocks.config.shiftEnterKeyBindingInstalled = true;
    expect(getNewlineInstructions(mocks.config)).toBe("shift + ⏎ for newline");

    mocks.config.shiftEnterKeyBindingInstalled = false;
    mocks.config.hasUsedBackslashReturn = true;
    expect(getNewlineInstructions(mocks.config)).toBe("\\⏎ for newline");

    mocks.config.hasUsedBackslashReturn = false;
    expect(getNewlineInstructions(mocks.config)).toBe(
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

  test("clamps workbench input columns to the framed composer chrome", () => {
    // A 140-column terminal leaves 136 columns inside the workbench frame.
    // Four padding cells, " YOLO ", the two-cell gap, and "▶ " leave 122
    // editable cells; the helper returns one extra cell for TextCursor.
    expect(
      clampWorkbenchPromptTextInputColumns(136, "YOLO", "▶", false),
    ).toBe(123);
    expect(
      clampWorkbenchPromptTextInputColumns(116, "DEFAULT", "›", false),
    ).toBe(100);
    expect(
      clampWorkbenchPromptTextInputColumns(136, "YOLO", "▶", true),
    ).toBe(114);
    expect(
      clampWorkbenchPromptTextInputColumns(10, "UNATTENDED", ">", true),
    ).toBe(0);
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
