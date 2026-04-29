import { describe, expect, test } from "vitest";

import { Cursor } from "./cursor.js";

describe("Cursor", () => {
  test("maps offsets through wrapped display lines", () => {
    const cursor = Cursor.fromText("abcdef", 4, 5);

    expect(cursor.render("", "", (text) => text)).toBe("abc\ndef");
    expect(cursor.getPosition()).toEqual({ line: 1, column: 2 });
  });

  test("moves over a grapheme cluster as one unit", () => {
    const family = "👨‍👩‍👧‍👦";
    const cursor = Cursor.fromText(`a${family}b`, 20, 1).right();

    expect(cursor.offset).toBe(1 + family.length);
    expect(Cursor.fromText(`a${family}b`, 20, cursor.offset).right().offset).toBe(
      1 + family.length + 1,
    );
  });

  test("centers the visible viewport around the cursor", () => {
    const cursor = Cursor.fromText("one\ntwo\nthree\nfour", 20, "one\ntwo\n".length);

    expect(cursor.getViewportStartLine(2)).toBe(1);
    expect(cursor.getViewportCharOffset(2)).toBe("one\n".length);
    expect(cursor.render("", "", (text) => text, undefined, 2)).toBe("two\nthree");
  });
});
