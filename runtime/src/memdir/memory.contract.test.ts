import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "..");

describe("memdir memory contract", () => {
  it("keeps every mapped memdir runtime file live", () => {
    for (const rel of [
      "runtime/src/memdir/memoryAge.ts",
      "runtime/src/memdir/teamMemPrompts.ts",
      "runtime/src/memdir/findRelevantMemories.ts",
      "runtime/src/memdir/paths.ts",
      "runtime/src/memdir/memoryScan.test.ts",
      "runtime/src/memdir/memdir.ts",
      "runtime/src/memdir/memoryTypes.ts",
      "runtime/src/memdir/teamMemPaths.ts",
      "runtime/src/memdir/memoryScan.ts",
    ]) {
      expect(existsSync(resolve(root, rel)), rel).toBe(true);
    }
  });
});
