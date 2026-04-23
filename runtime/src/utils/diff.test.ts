import { describe, expect, it } from "vitest";

import {
  countLinesChanged,
  getPatchForDisplay,
  getPatchFromContents,
} from "./diff.js";

describe("utils/diff", () => {
  it("computes hunks from raw contents without losing ampersands or dollars", () => {
    const patch = getPatchFromContents({
      filePath: "notes.txt",
      oldContent: "price = $10 & tax\n",
      newContent: "price = $12 & tax\n",
    });

    expect(patch).toHaveLength(1);
    expect(patch[0]?.lines.some((line) => line.includes("$12 & tax"))).toBe(true);
  });

  it("builds display hunks across replace_all edits", () => {
    const patch = getPatchForDisplay({
      filePath: "notes.txt",
      fileContents: "alpha\nbeta\nbeta\n",
      edits: [
        {
          old_string: "beta",
          new_string: "gamma",
          replace_all: true,
        },
      ],
    });

    expect(patch).toHaveLength(1);
    expect(patch[0]?.lines.filter((line) => line.startsWith("+"))).toHaveLength(2);
  });

  it("counts additions and removals from a structured patch", () => {
    const patch = getPatchFromContents({
      filePath: "notes.txt",
      oldContent: "alpha\nbeta\n",
      newContent: "alpha\ngamma\ndelta\n",
    });

    expect(countLinesChanged(patch)).toEqual({
      additions: 2,
      removals: 1,
    });
  });

  it("counts all lines for a new file preview", () => {
    expect(countLinesChanged([], "alpha\nbeta")).toEqual({
      additions: 2,
      removals: 0,
    });
  });
});
