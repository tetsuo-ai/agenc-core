import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  calculateCommandVisibleOptionCount,
  calculateHelpBodyHeight,
} from "./layout.js";

const source = readFileSync(new URL("./HelpV2.tsx", import.meta.url), "utf8");

describe("HelpV2 tab set", () => {
  test("has no inactive internal-only tab branch", () => {
    expect(source).not.toContain("antOnlyCommands");
    expect(source).not.toContain("INTERNAL_ONLY_COMMANDS");
    expect(source).not.toContain("false &&");
    expect(source).not.toContain("false ?");
  });
});

describe("HelpV2 layout budget", () => {
  test.each([
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 2],
    [24, 12],
  ])("keeps a positive help body height for terminal height %i", (rows, expected) => {
    expect(calculateHelpBodyHeight(rows)).toBe(expected);
  });

  test.each([
    [0, 0],
    [1, 0],
    [5, 0],
    [6, 1],
    [8, 2],
    [12, 4],
  ])("allows no command rows when the help body is too short: %i", (height, expected) => {
    expect(calculateCommandVisibleOptionCount(height)).toBe(expected);
  });
});
