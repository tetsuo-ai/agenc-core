import React from "react";
import { marked, type Tokens } from "marked";
import { describe, expect, it, vi } from "vitest";

// M-TUI-12 (core-todo.md): MarkdownTable ran ~4-5 O(rows×cols) layout passes
// (getMinWidth/getIdealWidth/calculateMaxRowLines/renderRowLines), each calling
// formatCell -> formatToken per cell with no memoization. formatCell is now
// memoized per render by the cell's tokens reference.

const counter = vi.hoisted(() => ({ formatToken: 0 }));

vi.mock("../../../../src/utils/markdown.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/utils/markdown.js")>();
  return {
    ...actual,
    formatToken: (...args: Parameters<typeof actual.formatToken>) => {
      counter.formatToken += 1;
      return actual.formatToken(...args);
    },
  };
});

const { MarkdownTable } = await import(
  "../../../../src/tui/components/markdown/MarkdownTable.js"
);
const { renderToString } = await import("../../../../src/utils/staticRender.js");

function parseTable(md: string): Tokens.Table {
  const t = marked.lexer(md).find((x) => x.type === "table");
  if (!t || t.type !== "table") throw new Error("expected a table");
  return t as Tokens.Table;
}

describe("MarkdownTable formatCell cache", () => {
  it("formats each cell once per render, not once per layout pass", async () => {
    const token = parseTable(
      ["| A | B |", "| :- | :- |", "| C | D |", "| E | F |"].join("\n"),
    );
    counter.formatToken = 0;
    const output = await renderToString(
      <MarkdownTable token={token} highlight={null} forceWidth={80} />,
      100,
    );
    // Sanity: the table actually rendered.
    expect(output).toContain("A");
    // 6 single-token cells: memoized formats each once (~6); the ~4-5 unmemoized
    // passes would run each cell's formatToken 4-5x (~24-30).
    expect(counter.formatToken).toBeLessThan(12);
  });
});
