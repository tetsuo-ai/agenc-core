import { describe, expect, test } from "vitest";
import { lightEditPreview } from "../../../src/tools/system/light-edit-preview.js";

describe("Light edited-region feedback", () => {
  test("exposes orphaned neighboring syntax after a declaration replacement", () => {
    const before = "def old(\n    value: int,\n) -> int: ...\n";
    const after = "def added() -> int: ...\n    value: int,\n) -> int: ...\n";
    const preview = lightEditPreview(before, after);
    expect(preview).toContain("1: def added() -> int: ...");
    expect(preview).toContain("2:     value: int,");
    expect(preview).toContain("3: ) -> int: ...");
  });
  test("shows both separate edits and the neighbors of a deletion", () => {
    const middle = Array.from({ length: 30 }, (_, i) => `keep ${i}`).join("\n");
    const preview = lightEditPreview(`remove\n${middle}\nold\n`, `${middle}\nnew\n`);
    expect(preview).toContain("1: keep 0");
    expect(preview).toContain("31: new");
    expect(preview).toContain("...");
  });
  test("bounds long additions and retains their end boundary", () => {
    const preview = lightEditPreview("tail\n", "added\n".repeat(200) + "tail\n");
    expect(preview.length).toBeLessThan(2500);
    expect(preview).toContain("201: tail");
  });
  test("does not split an oversized source line into a misleading excerpt", () => {
    const preview = lightEditPreview("old", "x".repeat(5000));
    expect(preview).toContain("Preview bounded");
    expect(preview.length).toBeLessThan(2500);
  });
});
