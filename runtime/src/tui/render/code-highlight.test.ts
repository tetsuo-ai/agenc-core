import { describe, expect, it } from "vitest";

import {
  renderHighlightedCodeLines,
  renderPlainCodeLines,
} from "./code-highlight.js";

describe("code-highlight", () => {
  it("wraps plain code lines to the requested width", () => {
    const lines = renderPlainCodeLines("const answer = 42;", 6);
    expect(lines.map((line) => line.plainText)).toEqual([
      "const ",
      "answer",
      " = 42;",
    ]);
  });

  it("renders ANSI-highlighted code when cli-highlight is available", async () => {
    const lines = await renderHighlightedCodeLines({
      code: "const answer = 42;",
      filePath: "answer.ts",
      width: 80,
    });

    expect(lines).not.toBeNull();
    expect(lines?.some((line) => line.text.includes("\u001b["))).toBe(true);
  });
});
