import { describe, expect, it } from "vitest";

import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";

describe("menu navigation", () => {
  it("wraps upward from the first row to the last row", () => {
    expect(previousMenuIndex(0, 4)).toBe(3);
  });

  it("wraps downward from the last row to the first row", () => {
    expect(nextMenuIndex(3, 4)).toBe(0);
  });

  it("clamps invalid counts to the first row", () => {
    expect(previousMenuIndex(0, 0)).toBe(0);
    expect(nextMenuIndex(0, 0)).toBe(0);
  });
});
