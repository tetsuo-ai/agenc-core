import { describe, expect, test, vi } from "vitest";

import { FileIndex } from "./index.js";

describe("FileIndex wave200-114 coverage", () => {
  test("keeps async indexing queryable while preserving top-k and top-level search semantics", async () => {
    expect(new FileIndex().search("", 3)).toEqual([]);

    const asyncIndex = new FileIndex();
    const paths = Array.from({ length: 300 }, (_, index) => {
      return `src/generated/path-${String(index).padStart(3, "0")}.ts`;
    });
    paths[5] = "src/early-target.ts";
    paths[299] = "src/late-target.ts";

    let now = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      now += 10;
      return now;
    });

    try {
      const { done, queryable } = asyncIndex.loadFromFileListAsync(paths);

      await queryable;

      expect(asyncIndex.search("early", 5).map(result => result.path)).toContain(
        "src/early-target.ts",
      );
      expect(asyncIndex.search("late", 5)).toEqual([]);

      await done;
    } finally {
      nowSpy.mockRestore();
    }

    expect(asyncIndex.search("late", 5).map(result => result.path)).toContain(
      "src/late-target.ts",
    );

    const orderedIndex = new FileIndex();
    orderedIndex.loadFromFileList([
      `a${"x".repeat(80)}b.ts`,
      "ab.ts",
      "axb.ts",
      `a${"x".repeat(200)}b.ts`,
      "ba.ts",
    ]);

    expect(orderedIndex.search("ab", 2).map(result => result.path)).toEqual([
      "ab.ts",
      "axb.ts",
    ]);

    const boundedIndex = new FileIndex();
    boundedIndex.loadFromFileList([
      "abc.ts",
      `a${"x".repeat(200)}b${"x".repeat(200)}c.ts`,
      "cba.ts",
    ]);

    expect(boundedIndex.search("abc", 1)).toEqual([
      { path: "abc.ts", score: 0 },
    ]);

    const topLevelIndex = new FileIndex();
    topLevelIndex.loadFromFileList([
      "zz00/file.ts",
      "aa00/file.ts",
      ...Array.from({ length: 100 }, (_, index) => {
        return `r${String(index).padStart(3, "0")}/file.ts`;
      }),
    ]);

    const topLevel = topLevelIndex.search("", 200).map(result => result.path);
    expect(topLevel).toHaveLength(100);
    expect(topLevel[0]).toBe("aa00");
    expect(topLevel).toContain("zz00");
    expect(topLevel).toContain("r097");
    expect(topLevel).not.toContain("r098");
  });
});
