import { describe, expect, test } from "vitest";

import { autoThemeForBackground, resolveThemeSetting, setCachedTerminalBackground, resetTerminalBackgroundCacheForTest } from "../../src/utils/terminalBackground.js";
import { getTheme, THEME_NAMES } from "../../src/utils/theme.js";

describe("default theme", () => {
  test("auto is olive on a dark terminal and light on a light one", () => {
    expect(autoThemeForBackground("dark")).toBe("olive");
    expect(autoThemeForBackground("light")).toBe("light");
    try {
      setCachedTerminalBackground("dark");
      expect(resolveThemeSetting("auto")).toBe("olive");
      setCachedTerminalBackground("light");
      expect(resolveThemeSetting("auto")).toBe("light");
    } finally {
      resetTerminalBackgroundCacheForTest();
    }
  });

  test("dark keeps the classic black and purple theme; olive is selectable", () => {
    expect(THEME_NAMES).toContain("olive");
    expect(resolveThemeSetting("dark")).toBe("dark");
    const olive = getTheme("olive");
    const dark = getTheme("dark");
    expect(olive.accent).not.toBe(dark.accent);
    expect(olive.text).not.toBe(dark.text);
    // Success and failure stay distinct from the wine accent.
    expect(new Set([olive.accent, olive.success, olive.error]).size).toBe(3);
  });
});
