import { describe, expect, it } from "vitest";

import {
  MAX_AUTHORITY_PATH_BYTES,
  normalizeExactAbsolutePath,
} from "../../src/utils/path-authority.js";

describe("normalizeExactAbsolutePath", () => {
  it("normalizes an absolute path without trimming it first", () => {
    expect(normalizeExactAbsolutePath("/tmp/../work/./run", "cwd")).toBe(
      "/work/run",
    );
    expect(normalizeExactAbsolutePath("//tmp//run", "cwd")).toBe("/tmp/run");
  });

  it("rejects empty, relative, and whitespace-padded paths", () => {
    expect(() => normalizeExactAbsolutePath("", "cwd")).toThrow(
      /cwd must be a non-empty absolute path/,
    );
    expect(() => normalizeExactAbsolutePath("relative/path", "cwd")).toThrow(
      /cwd must be an absolute path/,
    );
    expect(() => normalizeExactAbsolutePath(" /tmp/run", "cwd")).toThrow(
      /cwd must not contain surrounding whitespace/,
    );
    expect(() => normalizeExactAbsolutePath("/tmp/run ", "cwd")).toThrow(
      /cwd must not contain surrounding whitespace/,
    );
  });

  it("rejects a path over the UTF-8 byte budget", () => {
    const oversized = `/${"p".repeat(MAX_AUTHORITY_PATH_BYTES)}`;
    expect(() => normalizeExactAbsolutePath(oversized, "cwd")).toThrow(
      /cwd must not exceed 4096 UTF-8 bytes/,
    );
  });

  it("accepts a path at the UTF-8 byte budget", () => {
    const exact = `/${"p".repeat(MAX_AUTHORITY_PATH_BYTES - 1)}`;
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_AUTHORITY_PATH_BYTES);
    expect(normalizeExactAbsolutePath(exact, "cwd")).toBe(exact);
  });
});
