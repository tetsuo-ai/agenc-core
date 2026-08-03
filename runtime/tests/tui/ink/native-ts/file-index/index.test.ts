import { describe, expect, test } from "vitest";

import FileIndexDefault, {
  CHUNK_MS,
  FileIndex,
  yieldToEventLoop,
} from "./index.js";

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

    expect(results.map((result) => result.path)).toEqual(
      expect.arrayContaining([
        "src/fooBar.ts",
        "src/foo-bar.ts",
        "src/foo_bar.ts",
      ]),
    );
    expect(results[0]?.score).toBe(0);
    expect(
      results.every((result) => result.score >= 0 && result.score <= 1),
    ).toBe(true);
    expect(index.search("zz", 5)).toEqual([]);
  });

  test("uses smart-case matching", () => {
    const index = new FileIndex();
    index.loadFromFileList(["src/TestCase.ts", "src/testcase.ts"]);

    expect(index.search("tc", 5).map((result) => result.path)).toEqual([
      "src/TestCase.ts",
      "src/testcase.ts",
    ]);
    expect(index.search("TC", 5).map((result) => result.path)).toEqual([
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
    const testResult = results.find((result) => result.path.includes("test"));
    const nonTestResult = results.find(
      (result) => result.path === "src/app.ts",
    );

    expect(testResult).toBeDefined();
    expect(nonTestResult).toBeDefined();
    expect(testResult!.score).toBeGreaterThan(nonTestResult!.score);
  });

  test("keeps the preceding complete generation visible during async indexing", async () => {
    const index = new FileIndex();
    index.loadFromFileList(["src/previous.ts"]);
    const { done, queryable } = index.loadFromFileListAsync([
      "src/alpha.ts",
      "src/beta.ts",
      "src/gamma.ts",
    ]);

    expect(queryable).toBe(done);
    expect(index.search("previous", 5).map((result) => result.path)).toEqual([
      "src/previous.ts",
    ]);
    expect(index.search("alpha", 5)).toEqual([]);

    await done;
    expect(index.search("previous", 5)).toEqual([]);
    expect(index.search("gamma", 5).map((result) => result.path)).toContain(
      "src/gamma.ts",
    );
  });

  test("does not let a superseded async build replace a newer generation", async () => {
    const index = new FileIndex();
    const older = index.loadFromFileListAsync(
      Array.from({ length: 2_000 }, (_, value) => `old/${value}.ts`),
    );
    index.loadFromFileList(["new/canonical-generation.ts"]);

    await older.done;

    expect(index.search("canonical", 5).map((result) => result.path)).toEqual([
      "new/canonical-generation.ts",
    ]);
    expect(index.search("old", 5)).toEqual([]);
  });

  test("stops a superseded async build before preparing stale candidates", async () => {
    const index = new FileIndex();
    const stale = index.loadFromFileListAsync(["\ud800"]);
    const current = index.loadFromFileListAsync(["current.ts"]);

    await expect(stale.done).resolves.toBeUndefined();
    await expect(current.done).resolves.toBeUndefined();
    expect(index.search("current", 1).map((result) => result.path)).toEqual([
      "current.ts",
    ]);
  });

  test("requires every character after the former 64-character cutoff", () => {
    const index = new FileIndex();
    const prefix = "a".repeat(64);
    index.loadFromFileList([`${prefix}wrong.ts`, `${prefix}RIGHT.ts`]);

    expect(
      index.search(`${prefix}RIGHT`, 5).map((result) => result.path),
    ).toEqual([`${prefix}RIGHT.ts`]);
  });

  test("exports the default class and event-loop yield helper", async () => {
    expect(FileIndexDefault).toBe(FileIndex);
    expect(CHUNK_MS).toBeGreaterThan(0);
    await expect(yieldToEventLoop()).resolves.toBeUndefined();
  });
});
