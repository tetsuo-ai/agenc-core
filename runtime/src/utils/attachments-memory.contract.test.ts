import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");

describe("memory attachment contract", () => {
  it("has upstream-derived memory attachment functions in the live utility", () => {
    const target = resolve(root, "runtime/src/utils/attachments.ts");
    expect(existsSync(target)).toBe(true);
    const text = readFileSync(target, "utf8");
    expect(text).toContain("getRelevantMemoryAttachments");
    expect(text).toContain("readMemoriesForSurfacing");
    expect(text).toContain("startRelevantMemoryPrefetch");
    expect(text).toContain("filterDuplicateMemoryAttachments");
  });
});
