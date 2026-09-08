import { describe, expect, it } from "vitest";

import { parseRipgrepJsonLine } from "../../../src/tui/search/ripgrep-match.js";

describe("shared ripgrep JSON match parser", () => {
  it.each([
    { text: "needle", expected: "needle" },
    { text: "needle\n", expected: "needle" },
    { text: "needle\r", expected: "needle" },
    { text: "needle\r\n", expected: "needle" },
    { text: "first\nsecond\n", expected: "first\nsecond" },
    { text: "needle\n\n", expected: "needle\n" },
    { text: "", expected: "" },
  ])("strips one line terminator from $text", ({ text, expected }) => {
    expect(parseRipgrepJsonLine(JSON.stringify({
      type: "match",
      data: {
        path: { text: "/workspace/src/topic:12/app.ts" },
        line_number: 12,
        lines: { text },
      },
    }))).toEqual({
      file: "/workspace/src/topic:12/app.ts",
      line: 12,
      text: expected,
    });
  });

  it.each(["not json", "{", "null", "false", "[]", "{}", '{"type":"end"}'])(
    "ignores malformed or non-match input %s",
    (line) => expect(parseRipgrepJsonLine(line)).toBeNull(),
  );

  it.each([
    { name: "missing data", data: undefined },
    { name: "null data", data: null },
    { name: "missing path", data: { line_number: 1, lines: { text: "needle" } } },
    { name: "empty path", data: { path: { text: "" }, line_number: 1, lines: { text: "needle" } } },
    { name: "encoded path", data: { path: { bytes: "YQ==" }, line_number: 1, lines: { text: "needle" } } },
    { name: "invalid text", data: { path: { text: "app.ts" }, line_number: 1, lines: { text: 3 } } },
  ])("rejects $name", ({ data }) => {
    expect(parseRipgrepJsonLine(JSON.stringify({ type: "match", data }))).toBeNull();
  });

  it.each([
    { name: "missing", value: undefined },
    { name: "null", value: null },
    { name: "zero", value: 0 },
    { name: "negative", value: -1 },
    { name: "fractional", value: 1.5 },
    { name: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
    { name: "boolean", value: true },
    { name: "numeric string", value: "1" },
    { name: "array", value: [1] },
    { name: "object", value: { toString: 0, valueOf: 0 } },
  ])("rejects a $name line number", ({ value }) => {
    expect(parseRipgrepJsonLine(JSON.stringify({
      type: "match",
      data: {
        path: { text: "app.ts" },
        line_number: value,
        lines: { text: "needle" },
      },
    }))).toBeNull();
  });
});
