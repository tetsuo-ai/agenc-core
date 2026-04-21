/**
 * Wave 3-C: drag-drop extractor tests.
 *
 * Purely syntactic — no filesystem calls. Covers the three shape families
 * (file URLs, absolute POSIX paths, quoted paths) plus dedup + ordering
 * invariants and a negative case to make sure bare prose tokens are not
 * promoted to path candidates.
 */

import { describe, expect, test } from "vitest";

import { extractDroppedPaths } from "./drag-drop.js";

describe("extractDroppedPaths", () => {
  test("decodes a file:/// URL into a bare POSIX path", () => {
    expect(extractDroppedPaths("file:///foo.txt")).toEqual(["/foo.txt"]);
  });

  test("captures a plain absolute POSIX path", () => {
    expect(extractDroppedPaths("/tmp/x.md")).toEqual(["/tmp/x.md"]);
  });

  test("unwraps a double-quoted path containing spaces", () => {
    expect(extractDroppedPaths('"/path with space.txt"')).toEqual([
      "/path with space.txt",
    ]);
  });

  test("de-duplicates repeated path occurrences", () => {
    expect(
      extractDroppedPaths("/tmp/a.txt file:///tmp/a.txt /tmp/a.txt"),
    ).toEqual(["/tmp/a.txt"]);
  });

  test("preserves first-seen order across mixed shapes", () => {
    const input = `/first.txt "/tmp/second file.md" file:///third.log`;
    expect(extractDroppedPaths(input)).toEqual([
      "/first.txt",
      "/tmp/second file.md",
      "/third.log",
    ]);
  });

  test("ignores bare tokens that are not paths", () => {
    // "hello world foo bar" has no absolute-path shape anywhere.
    expect(extractDroppedPaths("hello world foo bar")).toEqual([]);
  });
});
