import { describe, expect, it } from "vitest";

import {
  groupSearchMatches,
  parseWorkbenchRipgrepJsonLine,
  visibleSearchRows,
} from "../../../src/tui/workbench/search/model.js";

describe("workbench search model", () => {
  it("parses ripgrep json match events while preserving path boundaries", () => {
    expect(parseWorkbenchRipgrepJsonLine(jsonMatchLine("src/app.ts", 12, "needle"), "/repo")).toEqual({
      id: "src/app.ts:12:needle",
      file: "src/app.ts",
      line: 12,
      text: "needle",
    });

    expect(parseWorkbenchRipgrepJsonLine(jsonMatchLine("C:/repo/src/app.ts", 8, "needle"), "C:/repo")).toEqual({
      id: "src/app.ts:8:needle",
      file: "src/app.ts",
      line: 8,
      text: "needle",
    });

    expect(parseWorkbenchRipgrepJsonLine("not-a-match", "/repo")).toBeNull();
  });

  it("keeps workspace files whose relative names start with dots relative", () => {
    expect(parseWorkbenchRipgrepJsonLine(jsonMatchLine("/repo/..config", 3, "needle"), "/repo")).toEqual({
      id: "..config:3:needle",
      file: "..config",
      line: 3,
      text: "needle",
    });
  });

  it("parses ripgrep json match events without splitting colon-number path segments", () => {
    expect(parseWorkbenchRipgrepJsonLine(jsonMatchLine("/repo/src/topic:12/app.ts", 4, "needle json\r\n"), "/repo")).toEqual({
      id: "src/topic:12/app.ts:4:needle json",
      file: "src/topic:12/app.ts",
      line: 4,
      text: "needle json",
    });

    expect(parseWorkbenchRipgrepJsonLine("not json", "/repo")).toBeNull();
    expect(parseWorkbenchRipgrepJsonLine(JSON.stringify({ type: "begin" }), "/repo")).toBeNull();
  });

  it("groups matches by file and exposes visible header rows", () => {
    const groups = groupSearchMatches([
      { id: "a:1:x", file: "a.ts", line: 1, text: "x" },
      { id: "a:4:y", file: "a.ts", line: 4, text: "y" },
      { id: "b:2:z", file: "b.ts", line: 2, text: "z" },
    ]);

    expect(groups).toEqual([
      {
        file: "a.ts",
        matches: [
          { id: "a:1:x", file: "a.ts", line: 1, text: "x" },
          { id: "a:4:y", file: "a.ts", line: 4, text: "y" },
        ],
      },
      {
        file: "b.ts",
        matches: [{ id: "b:2:z", file: "b.ts", line: 2, text: "z" }],
      },
    ]);
    expect(visibleSearchRows(groups).map((row) => row.id)).toEqual([
      "file:a.ts",
      "match:a:1:x",
      "match:a:4:y",
      "file:b.ts",
      "match:b:2:z",
    ]);
  });
});

function jsonMatchLine(file: string, line: number, text: string): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: file },
      line_number: line,
      lines: { text },
    },
  });
}
