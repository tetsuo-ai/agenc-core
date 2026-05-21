import { describe, expect, test } from "vitest";

import {
  pickToolResultDispatch,
  resultTextForTuiTool,
} from "../tool-result-routing.js";

describe("pickToolResultDispatch coverage swarm row 185", () => {
  test("exact routed tool names without their own envelope fall through to generic", () => {
    expect(pickToolResultDispatch("Write", "<read-content>x</read-content>")).toBe(
      "generic",
    );
    expect(
      pickToolResultDispatch("Grep", "<write-summary>x</write-summary>"),
    ).toBe("generic");
    expect(pickToolResultDispatch("Glob", "<grep-matches>x</grep-matches>")).toBe(
      "generic",
    );
  });

  test("tool-error envelope wins before later exact tool routes", () => {
    expect(
      pickToolResultDispatch(
        "Glob",
        "<glob-paths>src/index.ts</glob-paths>\n<tool-error>denied</tool-error>",
      ),
    ).toBe("tool-error-view");
  });
});

describe("resultTextForTuiTool coverage swarm row 185", () => {
  test("flattens empty arrays and object content text block arrays", () => {
    expect(resultTextForTuiTool([])).toBe("");
    expect(
      resultTextForTuiTool({
        content: [
          { type: "text", text: "<read-content>first</read-content>" },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("<read-content>first</read-content>\nsecond");
  });

  test("falls back to JSON for malformed block arrays and non-string content", () => {
    const nonTextBlock = { type: "image", text: "not flattened" };
    const nonStringTextBlock = { type: "text", text: 123 };

    expect(resultTextForTuiTool([nonTextBlock])).toBe(
      JSON.stringify(nonTextBlock),
    );
    expect(resultTextForTuiTool({ content: [nonStringTextBlock] })).toBe(
      JSON.stringify({ content: [nonStringTextBlock] }),
    );
    expect(resultTextForTuiTool({ content: 42 })).toBe('{"content":42}');
  });

  test("truncates long JSON fallback values to the short preview", () => {
    const value = { payload: "x".repeat(200) };
    const rendered = resultTextForTuiTool(value);

    expect(rendered).toBe(`${JSON.stringify(value).slice(0, 137)}...`);
    expect(rendered).toHaveLength(140);
  });

  test("stringifies primitive values when JSON.stringify does not return text", () => {
    expect(resultTextForTuiTool(Symbol("row-185"))).toBe("Symbol(row-185)");
    expect(resultTextForTuiTool(() => "ignored")).toContain("=>");
  });
});
