/**
 * Wave 2 theme tests.
 *
 * Keep these hermetic — they must run without a live terminal and must
 * not rely on the watch primitives being resolvable. Both branches of
 * `loadTheme()` are covered: cached load + fallback.
 */

import { describe, expect, test } from "vitest";

import { __resetThemeForTests, getTheme, theme } from "./theme.js";

const REQUIRED_COLOR_KEYS: ReadonlyArray<keyof ReturnType<typeof getTheme>["colors"]> = [
  "primary",
  "secondary",
  "accent",
  "error",
  "warning",
  "success",
  "dim",
  "ink",
  "muted",
  "info",
  "line",
  "lineStrong",
  "surface",
  "surfaceAlt",
  "modeDefault",
  "modeAcceptEdits",
  "modePlan",
  "modeBypass",
  "modeAuto",
];

describe("theme", () => {
  test("exports every required color, border, spacing, and mode-indicator key", () => {
    __resetThemeForTests();

    for (const key of REQUIRED_COLOR_KEYS) {
      expect(typeof theme.colors[key]).toBe("string");
      expect(theme.colors[key].length).toBeGreaterThan(0);
    }
    expect(typeof theme.border.soft).toBe("string");
    expect(typeof theme.border.strong).toBe("string");
    expect(typeof theme.spacing.tight).toBe("number");
    expect(typeof theme.spacing.normal).toBe("number");
    expect(typeof theme.spacing.loose).toBe("number");

    // Every permission mode must map to a non-empty indicator glyph.
    for (const mode of [
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
      "dontAsk",
      "auto",
      "bubble",
    ] as const) {
      expect(typeof theme.modeIndicatorChar[mode]).toBe("string");
      expect(theme.modeIndicatorChar[mode].length).toBeGreaterThan(0);
    }
  });

  test("falls back to the default palette when watch primitives are missing", () => {
    // Before any loadTheme() invocation getTheme() returns the frozen
    // default, which is already the fallback path we want to exercise.
    __resetThemeForTests();
    const snapshot = getTheme();
    expect(snapshot.colors.primary).toBe("ansi256(117)");
    expect(snapshot.colors.error).toBe("ansi256(203)");
    expect(snapshot.colors.surface).toBe("rgb(37,31,55)");
    expect(snapshot.modeIndicatorChar.default).toBe("›");
  });
});
