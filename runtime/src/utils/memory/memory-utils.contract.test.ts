import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");

describe("memory utility contract", () => {
  it("has memory utility files in live utility paths", () => {
    for (const target of [
      "runtime/src/memory/privacy.ts",
      "runtime/src/utils/memory/types.ts",
      "runtime/src/utils/memory/versions.ts",
    ]) {
      expect(existsSync(resolve(root, target))).toBe(true);
    }
  });
});
