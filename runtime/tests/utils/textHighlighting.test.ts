import { describe, expect, test } from "vitest";

import { segmentTextByHighlights } from "../../src/utils/textHighlighting.js";

describe("segmentTextByHighlights", () => {
  test("preserves zero-width control tokens inside highlighted text", () => {
    const controlSequence = "\x1B]0;title\x07";
    const text = `a${controlSequence}bc`;

    const segments = segmentTextByHighlights(text, [
      {
        start: 1,
        end: 3,
        color: "success",
        priority: 1,
      },
    ]);

    expect(segments).toEqual([
      { text: "a", start: 0 },
      {
        text: `${controlSequence}bc`,
        start: 1,
        highlight: {
          start: 1,
          end: 3,
          color: "success",
          priority: 1,
        },
      },
    ]);
  });

  test("does not count leading control tokens toward visible highlight ranges", () => {
    const controlSequence = "\x1B]2;window-title\x1B\\";
    const text = `${controlSequence}abc`;

    const segments = segmentTextByHighlights(text, [
      {
        start: 0,
        end: 1,
        color: "warning",
        priority: 1,
      },
    ]);

    expect(segments).toEqual([
      {
        text: `${controlSequence}a`,
        start: 0,
        highlight: {
          start: 0,
          end: 1,
          color: "warning",
          priority: 1,
        },
      },
      { text: "bc", start: 1 },
    ]);
  });
});
