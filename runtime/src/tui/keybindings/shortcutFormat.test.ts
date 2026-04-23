/**
 * Tests for the keybinding reverse-lookup helper used by non-React
 * callers (post-compact stdout breadcrumb, status hints, etc.).
 *
 * The helper mirrors the upstream `getShortcutDisplay(action, context,
 * fallback)` contract: known gut commands get a pretty-printed key
 * sequence, unknown actions fall back to the supplied default.
 */

import { describe, expect, test } from "vitest";

import {
  formatKeySequence,
  getDisplayForCommand,
  getShortcutDisplay,
} from "./shortcutFormat.js";

describe("formatKeySequence", () => {
  test("pretty-prints modifier chord", () => {
    expect(formatKeySequence("ctrl+r")).toBe("Ctrl+R");
    expect(formatKeySequence("ctrl+shift+a")).toBe("Ctrl+Shift+A");
  });

  test("pretty-prints special keys", () => {
    expect(formatKeySequence("enter")).toBe("Enter");
    expect(formatKeySequence("escape")).toBe("Esc");
    expect(formatKeySequence("pageup")).toBe("PageUp");
  });

  test("preserves multi-chord sequences", () => {
    expect(formatKeySequence("ctrl+x ctrl+e")).toBe("Ctrl+X Ctrl+E");
  });

  test("handles empty input", () => {
    expect(formatKeySequence("")).toBe("");
  });
});

describe("getDisplayForCommand", () => {
  test("finds global commands from any context", () => {
    expect(getDisplayForCommand("history:search", "chat")).toBe("Ctrl+R");
    expect(getDisplayForCommand("app:interrupt", "modal")).toBe("Ctrl+C");
  });

  test("finds chat commands from chat context", () => {
    expect(getDisplayForCommand("chat:submit", "chat")).toBe("Enter");
  });

  test("returns undefined for unbound commands in the requested context", () => {
    // chat:submit is bound in chat, not global, so a global-only walk
    // misses it.
    expect(getDisplayForCommand("chat:submit", "global")).toBeUndefined();
  });
});

describe("getShortcutDisplay", () => {
  test("returns the configured display for a known gut command", () => {
    expect(getShortcutDisplay("history:search", "global", "ctrl+r")).toBe(
      "Ctrl+R",
    );
  });

  test("falls back when the action is upstream-only and unknown to gut", () => {
    // app:toggleTranscript exists upstream but the gut TUI does not
    // implement it; the caller's fallback string must round-trip through
    // unchanged so the post-compact stdout breadcrumb stays coherent.
    expect(
      getShortcutDisplay("app:toggleTranscript", "Global", "ctrl+o"),
    ).toBe("ctrl+o");
  });

  test("accepts upstream-style capitalized context names", () => {
    expect(getShortcutDisplay("history:search", "Global", "ctrl+r")).toBe(
      "Ctrl+R",
    );
  });
});
