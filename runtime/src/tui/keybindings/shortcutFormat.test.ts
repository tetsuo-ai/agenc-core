/**
 * Tests for the keybinding reverse-lookup helper used by non-React
 * callers (post-compact stdout breadcrumb, status hints, etc.).
 *
 * The helper mirrors the upstream `getShortcutDisplay(action, context,
 * fallback)` contract: known gut commands get a pretty-printed key
 * sequence, unknown actions fall back to the supplied default.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  formatKeySequence,
  getDisplaysForCommand,
  getDisplayForCommand,
  getShortcutDisplay,
} from "./shortcutFormat.js";

let tempHome: string;
let previousAgencHome: string | undefined;

beforeEach(() => {
  previousAgencHome = process.env.AGENC_HOME;
  tempHome = mkdtempSync(join(tmpdir(), "agenc-shortcuts-"));
  process.env.AGENC_HOME = tempHome;
});

afterEach(() => {
  if (previousAgencHome === undefined) {
    delete process.env.AGENC_HOME;
  } else {
    process.env.AGENC_HOME = previousAgencHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

describe("formatKeySequence", () => {
  test("pretty-prints modifier chord", () => {
    expect(formatKeySequence("ctrl+r")).toBe("Ctrl+R");
    expect(formatKeySequence("ctrl+shift+a")).toBe("Ctrl+Shift+A");
  });

  test("pretty-prints special keys", () => {
    expect(formatKeySequence("enter")).toBe("Enter");
    expect(formatKeySequence("escape")).toBe("Esc");
    expect(formatKeySequence("pageup")).toBe("PageUp");
    expect(formatKeySequence("space")).toBe("Space");
  });

  test("preserves multi-chord sequences", () => {
    expect(formatKeySequence("ctrl+x ctrl+e")).toBe("Ctrl+X Ctrl+E");
  });

  test("handles empty input", () => {
    expect(formatKeySequence("")).toBe("");
  });
});

describe("getDisplayForCommand", () => {
  test("returns all bound displays for commands with multiple shortcuts", () => {
    expect(getDisplaysForCommand("chat:newline", "chat")).toEqual([
      "Shift+Enter",
      "Ctrl+J",
    ]);
  });

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

  test("resolves the upstream transcript toggle action in AgenC", () => {
    expect(
      getShortcutDisplay("app:toggleTranscript", "Global", "ctrl+o"),
    ).toBe("Ctrl+O");
  });

  test("accepts upstream-style capitalized context names", () => {
    expect(getShortcutDisplay("history:search", "Global", "ctrl+r")).toBe(
      "Ctrl+R",
    );
  });

  test("uses AgenC keybindings.json overrides for display hints", () => {
    mkdirSync(tempHome, { recursive: true });
    writeFileSync(
      join(tempHome, "keybindings.json"),
      JSON.stringify({
        bindings: [
          {
            context: "Global",
            bindings: {
              "ctrl+k": "history:search",
            },
          },
        ],
      }),
      "utf8",
    );

    expect(getShortcutDisplay("history:search", "Global", "ctrl+r")).toBe(
      "Ctrl+K",
    );
  });
});
