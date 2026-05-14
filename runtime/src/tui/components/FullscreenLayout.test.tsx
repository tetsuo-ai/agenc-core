import { describe, expect, test } from "vitest";

import {
  calculateFullscreenLayoutBudget,
  calculateModalViewport,
  isNoColorEnv,
} from "./FullscreenLayout.js";

describe("FullscreenLayout modal viewport", () => {
  test.each([0, 1, 2, 3])(
    "clamps modal rows and maxHeight for tiny terminal height %i",
    (rows) => {
      const viewport = calculateModalViewport(rows, 3);

      expect(viewport.rows).toBeGreaterThanOrEqual(0);
      expect(viewport.columns).toBeGreaterThanOrEqual(0);
      expect(viewport.maxHeight).toBeGreaterThanOrEqual(0);
    },
  );

  test("preserves normal modal sizing on larger terminals", () => {
    expect(calculateModalViewport(24, 100)).toEqual({
      rows: 21,
      columns: 96,
      maxHeight: 22,
    });
  });

  test.each([
    [0, { showTopChrome: false, showScrollable: false, showBottomChrome: false, bottomMaxHeight: 1 }],
    [1, { showTopChrome: false, showScrollable: false, showBottomChrome: false, bottomMaxHeight: 1 }],
    [3, { showTopChrome: false, showScrollable: true, showBottomChrome: false, bottomMaxHeight: 2 }],
    [5, { showTopChrome: false, showScrollable: true, showBottomChrome: true, bottomMaxHeight: 2 }],
    [8, { showTopChrome: true, showScrollable: true, showBottomChrome: true, bottomMaxHeight: 2 }],
    [24, { showTopChrome: true, showScrollable: true, showBottomChrome: true, bottomMaxHeight: 10 }],
  ])("keeps a positive bottom slot budget at terminal height %i", (rows, expected) => {
    expect(calculateFullscreenLayoutBudget(rows)).toEqual(expected);
  });

  test("detects no-color terminal modes", () => {
    expect(isNoColorEnv({ NO_COLOR: "1" })).toBe(true);
    expect(isNoColorEnv({ FORCE_COLOR: "0" })).toBe(true);
    expect(isNoColorEnv({ TERM: "dumb" })).toBe(true);
    expect(isNoColorEnv({ TERM: "xterm-256color" })).toBe(false);
  });
});
