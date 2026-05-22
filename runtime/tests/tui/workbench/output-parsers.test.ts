import { describe, expect, it } from "vitest";

import {
  parseSourceLocations,
  parseVitestFailures,
} from "../../../src/tui/workbench/surfaces/outputParsers.js";

describe("workbench output parsers", () => {
  it("extracts unique source locations", () => {
    expect(parseSourceLocations("src/app.ts:12:4\nsrc/app.ts:12:4\n./test/foo.test.tsx:8")).toEqual([
      { file: "src/app.ts", line: 12, column: 4 },
      { file: "./test/foo.test.tsx", line: 8 },
    ]);
  });

  it("extracts Vitest-style failure summaries", () => {
    const failures = parseVitestFailures(`
 FAIL  tests/app.test.ts > renders app
 AssertionError: expected false to be true
 tests/app.test.ts:42:7
`);

    expect(failures).toEqual([
      {
        id: "tests/app.test.ts > renders app:tests/app.test.ts:42",
        name: "tests/app.test.ts > renders app",
        location: { file: "tests/app.test.ts", line: 42, column: 7 },
        message: "AssertionError: expected false to be true",
      },
    ]);
  });
});
