import { describe, expect, test } from "vitest";

import { TextCursor } from "../../src/utils/TextCursor.js";

/**
 * Regression test for firstNonBlankInLine().
 *
 * The regex `/^\s*\S/` is anchored, so `match.index` is always 0 on a match.
 * The previous implementation derived the column from `match.index` (a falsy 0),
 * so it always returned column 0 — never the actual first-non-blank column.
 *
 * Contract: firstNonBlankInLine() returns the column of the first
 * non-whitespace character (i.e. the count of leading whitespace), or column 0
 * for an empty / all-whitespace line (matching firstNonBlankInLogicalLine).
 */
describe("TextCursor.firstNonBlankInLine", () => {
  // Wide width so single-line inputs do not soft-wrap; column == leading ws.
  const COLUMNS = 200;

  function firstNonBlankColumn(line: string): number {
    // Start at end of the line so the cursor is on the intended wrapped line.
    const cursor = TextCursor.fromText(line, COLUMNS, line.length);
    return cursor.firstNonBlankInLine().getPosition().column;
  }

  test("returns leading-whitespace length for an indented line", () => {
    expect(firstNonBlankColumn("    foo")).toBe(4);
  });

  test("counts tab characters as leading whitespace (display columns)", () => {
    // MeasuredText expands tabs to TAB_SIZE (8) display columns, so the first
    // non-blank char after two tabs sits at display column 16, not raw index 2.
    expect(firstNonBlankColumn("\t\tbar")).toBe(16);
  });

  test("returns 0 for a line with no indentation", () => {
    expect(firstNonBlankColumn("noindent")).toBe(0);
  });

  test("returns 0 for an empty line", () => {
    expect(firstNonBlankColumn("")).toBe(0);
  });

  test("returns 0 for an all-whitespace line", () => {
    expect(firstNonBlankColumn("     ")).toBe(0);
  });
});
