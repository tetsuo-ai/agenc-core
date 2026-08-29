import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getTerminalBackground,
  isTerminalBackgroundDetected,
  resetTerminalBackgroundCacheForTest,
  setCachedTerminalBackground,
} from "../../src/utils/terminalBackground.js";

// M-ONB-2: getTerminalBackground() defaults to 'dark' when the
// background can't be measured ($COLORFGBG absent, no OSC 11), so callers could
// not tell a measured dark from a guessed dark. isTerminalBackgroundDetected() exposes
// that distinction.

const originalColorFgBg = process.env.COLORFGBG;

beforeEach(() => {
  resetTerminalBackgroundCacheForTest();
});

afterEach(() => {
  if (originalColorFgBg === undefined) delete process.env.COLORFGBG;
  else process.env.COLORFGBG = originalColorFgBg;
  resetTerminalBackgroundCacheForTest();
});

describe("isTerminalBackgroundDetected", () => {
  it("is false when COLORFGBG is absent (defaulted dark)", () => {
    delete process.env.COLORFGBG;
    expect(getTerminalBackground()).toBe("dark");
    expect(isTerminalBackgroundDetected()).toBe(false);
  });

  it("is true for a dark background measured from COLORFGBG", () => {
    process.env.COLORFGBG = "15;0"; // bg index 0 = dark
    expect(getTerminalBackground()).toBe("dark");
    expect(isTerminalBackgroundDetected()).toBe(true);
  });

  it("is true for a light background measured from COLORFGBG", () => {
    process.env.COLORFGBG = "0;15"; // bg index 15 = light
    expect(getTerminalBackground()).toBe("light");
    expect(isTerminalBackgroundDetected()).toBe(true);
  });

  it("becomes true after an OSC 11 watcher update", () => {
    delete process.env.COLORFGBG;
    getTerminalBackground(); // defaults dark, not detected
    expect(isTerminalBackgroundDetected()).toBe(false);
    setCachedTerminalBackground("light");
    expect(isTerminalBackgroundDetected()).toBe(true);
    expect(getTerminalBackground()).toBe("light");
  });
});
