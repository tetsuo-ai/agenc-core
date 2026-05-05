import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");

describe("memory component contract", () => {
  it("has the memory component source files in live component paths", () => {
    for (const target of [
      "runtime/src/components/MemoryUsageIndicator.tsx",
      "runtime/src/components/memory/MemoryFileSelector.tsx",
      "runtime/src/components/memory/MemoryUpdateNotification.tsx",
      "runtime/src/components/memory/memoryFileSelectorPaths.ts",
      "runtime/src/components/messages/UserMemoryInputMessage.tsx",
    ]) {
      expect(existsSync(resolve(root, target))).toBe(true);
    }
  });
});
