import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSystemThemeName,
  isSystemThemeDetected,
  resetSystemThemeCacheForTest,
  setCachedSystemTheme,
} from "../../src/utils/systemTheme.js";

// M-ONB-2 (core-todo.md): getSystemThemeName() defaults to 'dark' when the
// background can't be measured ($COLORFGBG absent, no OSC 11), so callers could
// not tell a measured dark from a guessed dark. isSystemThemeDetected() exposes
// that distinction.

const originalColorFgBg = process.env.COLORFGBG;

beforeEach(() => {
  resetSystemThemeCacheForTest();
});

afterEach(() => {
  if (originalColorFgBg === undefined) delete process.env.COLORFGBG;
  else process.env.COLORFGBG = originalColorFgBg;
  resetSystemThemeCacheForTest();
});

describe("isSystemThemeDetected", () => {
  it("is false when COLORFGBG is absent (defaulted dark)", () => {
    delete process.env.COLORFGBG;
    expect(getSystemThemeName()).toBe("dark");
    expect(isSystemThemeDetected()).toBe(false);
  });

  it("is true for a dark background measured from COLORFGBG", () => {
    process.env.COLORFGBG = "15;0"; // bg index 0 = dark
    expect(getSystemThemeName()).toBe("dark");
    expect(isSystemThemeDetected()).toBe(true);
  });

  it("is true for a light background measured from COLORFGBG", () => {
    process.env.COLORFGBG = "0;15"; // bg index 15 = light
    expect(getSystemThemeName()).toBe("light");
    expect(isSystemThemeDetected()).toBe(true);
  });

  it("becomes true after an OSC 11 watcher update", () => {
    delete process.env.COLORFGBG;
    getSystemThemeName(); // defaults dark, not detected
    expect(isSystemThemeDetected()).toBe(false);
    setCachedSystemTheme("light");
    expect(isSystemThemeDetected()).toBe(true);
    expect(getSystemThemeName()).toBe("light");
  });
});
