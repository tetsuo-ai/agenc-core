import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "..");

describe("memory subsystem contract", () => {
  it("keeps MM-01 memory runtime files in the owned memory directory", () => {
    for (const rel of [
      "runtime/src/memory/age.ts",
      "runtime/src/memory/agencmd.ts",
      "runtime/src/memory/detection.ts",
      "runtime/src/memory/find-relevant.ts",
      "runtime/src/memory/memdir.ts",
      "runtime/src/memory/paths.ts",
      "runtime/src/memory/scan.ts",
      "runtime/src/memory/store.ts",
      "runtime/src/memory/types.ts",
    ]) {
      expect(existsSync(resolve(root, rel)), rel).toBe(true);
    }
  });

  it("keeps only allowed production files in the old memdir boundary", () => {
    for (const rel of [
      "runtime/src/memdir/memory-types.ts",
      "runtime/src/memdir/teamMemPrompts.ts",
      "runtime/src/memdir/teamMemPaths.ts",
    ]) {
      expect(existsSync(resolve(root, rel)), rel).toBe(true);
    }
    const productionFiles = readdirSync(resolve(root, "runtime/src/memdir"))
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !entry.endsWith(".test.ts"))
      .sort();
    expect(productionFiles).toEqual([
      "memory-types.ts",
      "teamMemPaths.ts",
      "teamMemPrompts.ts",
    ]);
  });
});
