import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");
const matrix = JSON.parse(
  readFileSync(resolve(root, "parity/openclaude-memory-parity.json"), "utf8"),
) as { removedFiles: string[] };

describe("memory wiring contract", () => {
  it("removes the replaced AgenC custom memory files", () => {
    for (const rel of matrix.removedFiles) {
      expect(existsSync(resolve(root, rel))).toBe(false);
    }
  });

  it("does not import the replaced memory module paths", () => {
    const registry = readFileSync(
      resolve(root, "runtime/src/commands/registry.ts"),
      "utf8",
    );
    const bootstrap = readFileSync(resolve(root, "runtime/src/bin/bootstrap.ts"), "utf8");
    const agenc = readFileSync(resolve(root, "runtime/src/bin/agenc.ts"), "utf8");
    expect(registry).not.toContain('./memory.js');
    expect(bootstrap).not.toContain("../prompts/memory/index.js");
    expect(bootstrap).not.toContain("./memory-bootstrap.js");
    expect(agenc).not.toContain("../prompts/memory/index.js");
  });
});
