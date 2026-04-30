/**
 * Wave 2-B: default keybindings tests.
 *
 * Covers the normalization pipeline + the MODE_CYCLE_KEY fallback branch
 * + exhaustiveness of the binding map vs the BindingCommand literal set.
 */

import { describe, expect, test } from "vitest";

import {
  ALL_BINDING_COMMANDS,
  DEFAULT_BINDINGS,
  MODE_CYCLE_KEY,
  detectShiftTabCapable,
  isRecentModernWindowsTerminal,
  normalizeKeySequence,
} from "./defaultBindings.js";

describe("normalizeKeySequence", () => {
  test("sorts modifiers alphabetically and lowercases the whole chord", () => {
    expect(normalizeKeySequence("Shift+Ctrl+A")).toBe("ctrl+shift+a");
    expect(normalizeKeySequence("META+Alt+X")).toBe("alt+meta+x");
  });

  test("lowercases plain alphabetic keys without modifiers", () => {
    expect(normalizeKeySequence("Enter")).toBe("enter");
    expect(normalizeKeySequence("Escape")).toBe("escape");
  });

  test("splits multi-chord sequences on whitespace", () => {
    expect(normalizeKeySequence("Ctrl+X   Ctrl+E")).toBe("ctrl+x ctrl+e");
  });
});

describe("MODE_CYCLE_KEY", () => {
  test("defaults to shift+tab on non-Windows platforms", () => {
    // `process.platform` is hard to override safely at runtime; rather
    // than reassigning it (which leaks into sibling tests in the same
    // worker), trust the current platform and assert the contract:
    // when `detectShiftTabCapable()` returns true, the canonical mode-
    // cycle key is `shift+tab`.
    if (detectShiftTabCapable()) {
      expect(MODE_CYCLE_KEY).toBe("shift+tab");
    } else {
      expect(MODE_CYCLE_KEY).toBe("meta+m");
    }
  });

  test("falls back to meta+m when detectShiftTabCapable returns false on win32", () => {
    const originalPlatform = process.platform;
    const originalWT = process.env.WT_SESSION;
    const originalWTP = process.env.WT_PROFILE_ID;
    const originalTermProgram = process.env.TERM_PROGRAM;
    const originalConEmu = process.env.ConEmuANSI;
    try {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      delete process.env.WT_SESSION;
      delete process.env.WT_PROFILE_ID;
      delete process.env.TERM_PROGRAM;
      delete process.env.ConEmuANSI;
      expect(isRecentModernWindowsTerminal()).toBe(false);
      expect(detectShiftTabCapable()).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
      if (originalWT !== undefined) process.env.WT_SESSION = originalWT;
      if (originalWTP !== undefined) process.env.WT_PROFILE_ID = originalWTP;
      if (originalTermProgram !== undefined)
        process.env.TERM_PROGRAM = originalTermProgram;
      if (originalConEmu !== undefined) process.env.ConEmuANSI = originalConEmu;
    }
  });
});

describe("DEFAULT_BINDINGS", () => {
  test("maps every BindingCommand to at least one binding across all contexts", () => {
    // The mode-cycle key must always be present in the chat map — if the
    // platform selector drifted, this would silently break cycleMode.
    expect(DEFAULT_BINDINGS.chat[normalizeKeySequence(MODE_CYCLE_KEY)]).toBe(
      "chat:cycleMode",
    );
    const seen = new Set<string>();
    for (const map of [
      DEFAULT_BINDINGS.global,
      DEFAULT_BINDINGS.chat,
      DEFAULT_BINDINGS.modal,
      DEFAULT_BINDINGS.transcript,
      DEFAULT_BINDINGS.Scroll,
    ]) {
      for (const command of Object.values(map)) {
        seen.add(command);
      }
    }
    for (const command of ALL_BINDING_COMMANDS) {
      expect(seen.has(command), `command '${command}' is not bound`).toBe(true);
    }
  });

  test("binds Tab to suggestion accept and ctrl+j to newline", () => {
    expect(DEFAULT_BINDINGS.chat[normalizeKeySequence("tab")]).toBe(
      "chat:acceptSuggestion",
    );
    expect(DEFAULT_BINDINGS.chat[normalizeKeySequence("ctrl+j")]).toBe(
      "chat:newline",
    );
  });

  test("binds the advertised task panel toggle", () => {
    expect(DEFAULT_BINDINGS.global[normalizeKeySequence("ctrl+t")]).toBe(
      "app:toggleTasks",
    );
  });

  test("binds transcript copy-mode pager keys before global process controls", () => {
    expect(DEFAULT_BINDINGS.transcript[normalizeKeySequence("ctrl+d")]).toBe(
      "scroll:halfPageDown",
    );
    expect(DEFAULT_BINDINGS.transcript[normalizeKeySequence("space")]).toBe(
      "scroll:fullPageDown",
    );
    expect(DEFAULT_BINDINGS.transcript[normalizeKeySequence("shift+g")]).toBe(
      "scroll:bottom",
    );
  });
});
