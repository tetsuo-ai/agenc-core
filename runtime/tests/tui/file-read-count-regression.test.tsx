import React from "react";
import { describe, expect, it } from "vitest";
import { formatStructuredToolResult } from "../../src/tui/session-transcript.js";
import { FileReadView } from "../../src/tui/tool-rendering.js";
import { renderToString } from "../../src/utils/staticRender.js";

describe("live FileRead line counts", () => {
  it.each([403, 50, 1, 0])("preserves %i returned lines before transcript clamping", async (numLines) => {
    const result = Array.from({ length: numLines }, (_, index) => ` ${index + 101}→line ${index}`).join("\n");
    const blocks = formatStructuredToolResult("FileRead", "tool_call_completed", {
      result,
      metadata: { numLines, totalLines: 500, startLine: 101 },
    });
    const rendered = await renderToString(<FileReadView content={blocks.map(block => block.text).join("\n")} />);
    expect(rendered).toContain(numLines === 0 ? "(empty file)" : `Read ${numLines} ${numLines === 1 ? "line" : "lines"}`);
    expect(blocks.map(block => block.text).join("\n").length).toBeLessThan(100);
  });

  it("counts all numbered rows when older results lack metadata", async () => {
    const blocks = formatStructuredToolResult("FileRead", "tool_call_completed", {
      result: " 21→first\n 22→second\n 23→third",
    });
    const rendered = await renderToString(<FileReadView content={blocks.map(block => block.text).join("\n")} />);
    expect(rendered).toContain("Read 3 lines");
  });
});
