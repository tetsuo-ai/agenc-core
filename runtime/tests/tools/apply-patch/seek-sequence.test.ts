import { describe, expect, test } from "vitest";

import { seekSequence } from "./seek-sequence.js";

describe("seekSequence", () => {
  test("returns the matching index for a normal (non-EOF) scan", () => {
    expect(seekSequence(["a", "b", "c", "d"], ["b", "c"], 0, false)).toBe(1);
  });

  test("returns null when the pattern is absent", () => {
    expect(seekSequence(["a", "b", "c"], ["x", "y"], 0, false)).toBeNull();
  });

  test("EOF: matches when the pattern is flush against the end of file", () => {
    expect(seekSequence(["x", "y", "z"], ["y", "z"], 0, true)).toBe(1);
  });

  test("EOF: falls back to a scan from start for a non-flush pattern", () => {
    // Regression: the EOF path used to pin the search to the flush position
    // only, so a non-flush EOF hunk failed to apply. It must fall back to a
    // normal scan (matching the donor's two-phase behavior).
    expect(seekSequence(["x", "y", "z"], ["x", "y"], 0, true)).toBe(0);
  });

  test("EOF: prefers the flush position over an earlier match", () => {
    // "a" appears at index 0 and 2; flush-against-EOF (index 2) must win.
    expect(seekSequence(["a", "b", "a"], ["a"], 0, true)).toBe(2);
  });

  test("empty pattern returns the start index", () => {
    expect(seekSequence(["a", "b"], [], 1, false)).toBe(1);
  });

  test("pattern longer than the file returns null", () => {
    expect(seekSequence(["a"], ["a", "b"], 0, true)).toBeNull();
  });
});
