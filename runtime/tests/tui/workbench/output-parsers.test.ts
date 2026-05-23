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

  it("keeps source paths that contain spaces", () => {
    expect(
      parseSourceLocations(
        "Error: packages/app with spaces/src/render app.test.tsx:27:9\n" +
          "    at render (packages/app with spaces/src/render app.test.tsx:27:9)\n" +
          "C:\\Users\\AgenC Project\\src\\app.test.ts:10:2",
      ),
    ).toEqual([
      { file: "packages/app with spaces/src/render app.test.tsx", line: 27, column: 9 },
      { file: "C:\\Users\\AgenC Project\\src\\app.test.ts", line: 10, column: 2 },
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

  it("extracts Vitest failure locations whose paths contain spaces", () => {
    const failures = parseVitestFailures(`
 FAIL  tests/app with spaces.test.ts > renders app
 AssertionError: expected false to be true
 tests/app with spaces.test.ts:42:7
`);

    expect(failures).toEqual([
      {
        id: "tests/app with spaces.test.ts > renders app:tests/app with spaces.test.ts:42",
        name: "tests/app with spaces.test.ts > renders app",
        location: { file: "tests/app with spaces.test.ts", line: 42, column: 7 },
        message: "AssertionError: expected false to be true",
      },
    ]);
  });

  it("keeps Vitest failures that do not include source locations", () => {
    const failures = parseVitestFailures(" FAIL  tests/app.test.ts > fails before stack");

    expect(failures).toEqual([
      {
        id: "tests/app.test.ts > fails before stack:0:0",
        name: "tests/app.test.ts > fails before stack",
        message: "FAIL  tests/app.test.ts > fails before stack",
      },
    ]);
  });
});
