import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "..");

describe("memory wiring contract", () => {
  it("removes the replaced custom memory files", () => {
    for (const rel of [
      "runtime/src/commands/memory.ts",
      "runtime/src/bin/memory-bootstrap.ts",
      "runtime/src/prompts/attachments/relevant-memory.ts",
      "runtime/src/prompts/memory/index.ts",
      "runtime/src/prompts/memory/loader.ts",
      "runtime/src/prompts/memory/types.ts",
    ]) {
      expect(existsSync(resolve(root, rel)), rel).toBe(false);
    }
  });

  it("does not import the replaced memory module paths", () => {
    const registry = readFileSync(resolve(root, "runtime/src/commands/registry.ts"), "utf8");
    const bootstrap = readFileSync(resolve(root, "runtime/src/bin/bootstrap.ts"), "utf8");
    const agenc = readFileSync(resolve(root, "runtime/src/bin/agenc.ts"), "utf8");
    expect(registry).not.toContain("./memory.js");
    expect(bootstrap).not.toContain("../prompts/memory/index.js");
    expect(bootstrap).not.toContain("./memory-bootstrap.js");
    expect(agenc).not.toContain("../prompts/memory/index.js");
  });
});
