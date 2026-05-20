import { describe, expect, test } from "vitest";

import FileIndexDefault, { CHUNK_MS, FileIndex, yieldToEventLoop } from "./index.js";

describe("FileIndex", () => {
  test("deduplicates loaded paths and returns sorted top-level entries for empty queries", () => {
    const index = new FileIndex();
    index.loadFromFileList([
      "",
      "runtime/src/tui/App.tsx",
      "src/index.ts",
      "src/index.ts",
      "README.md",
      "docs/guide.md",
      "package.json",
    ]);

    expect(index.search("", 10)).toEqual([
      { path: "src", score: 0 },
      { path: "docs", score: 0 },
      { path: "runtime", score: 0 },
      { path: "README.md", score: 0 },
      { path: "package.json", score: 0 },
    ]);
    expect(index.search("", 2)).toEqual([
      { path: "src", score: 0 },
      { path: "docs", score: 0 },
    ]);
    expect(index.search("", 0)).toEqual([]);
  });

  test("performs fuzzy searches with boundary and camel-case bonuses", () => {
    const index = new FileIndex();
    index.loadFromFileList([
      "src/fooBar.ts",
      "src/foo-bar.ts",
      "src/foo_bar.ts",
      "src/other.ts",
      "runtime/src/tui/PromptInput.tsx",
    ]);

    const results = index.search("fb", 5);

    expect(results.map(result => result.path)).toEqual(
      expect.arrayContaining([
        "src/fooBar.ts",
        "src/foo-bar.ts",
        "src/foo_bar.ts",
      ]),
    );
    expect(results[0]?.score).toBe(0);
    expect(results.every(result => result.score >= 0 && result.score <= 1)).toBe(
      true,
    );
    expect(index.search("zz", 5)).toEqual([]);
  });

  test("uses smart-case matching", () => {
    const index = new FileIndex();
    index.loadFromFileList(["src/TestCase.ts", "src/testcase.ts"]);

    expect(index.search("tc", 5).map(result => result.path)).toEqual([
      "src/TestCase.ts",
      "src/testcase.ts",
    ]);
    expect(index.search("TC", 5).map(result => result.path)).toEqual([
      "src/TestCase.ts",
    ]);
  });

  test("penalizes test paths in result scores", () => {
    const index = new FileIndex();
    index.loadFromFileList([
      "src/app.ts",
      "src/app.test.ts",
      "src/application.ts",
    ]);

    const results = index.search("app", 3);
    const testResult = results.find(result => result.path.includes("test"));
    const nonTestResult = results.find(result => result.path === "src/app.ts");

    expect(testResult).toBeDefined();
    expect(nonTestResult).toBeDefined();
    expect(testResult!.score).toBeGreaterThan(nonTestResult!.score);
  });

  test("searches only the ready prefix while async indexing is in progress", async () => {
    const index = new FileIndex();
    const { done, queryable } = index.loadFromFileListAsync([
      "src/alpha.ts",
      "src/beta.ts",
      "src/gamma.ts",
    ]);

    await queryable;
    expect(index.search("alpha", 5).map(result => result.path)).toContain(
      "src/alpha.ts",
    );

    await done;
    expect(index.search("gamma", 5).map(result => result.path)).toContain(
      "src/gamma.ts",
    );
  });

  test("exports the default class and event-loop yield helper", async () => {
    expect(FileIndexDefault).toBe(FileIndex);
    expect(CHUNK_MS).toBeGreaterThan(0);
    await expect(yieldToEventLoop()).resolves.toBeUndefined();
  });
});
