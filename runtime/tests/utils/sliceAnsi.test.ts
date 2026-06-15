import { describe, expect, test } from "vitest";

import sliceAnsi from "../../src/utils/sliceAnsi.js";

describe("sliceAnsi", () => {
  test("preserves zero-width control tokens without advancing visible slices", () => {
    const controlSequence = "\x1B]0;window-title\x07";
    const text = `a${controlSequence}bc`;

    expect(sliceAnsi(text, 0, 1)).toBe("a");
    expect(sliceAnsi(text, 0, 2)).toBe(`a${controlSequence}b`);
    expect(sliceAnsi(text, 1, 3)).toBe(`${controlSequence}bc`);
    expect(sliceAnsi(text, 0, 1) + sliceAnsi(text, 1, 3)).toBe(text);
  });
});
