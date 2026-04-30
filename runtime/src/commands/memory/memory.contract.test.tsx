import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");

describe("memory command contract", () => {
  it("uses the copied memory command directory in the command registry", () => {
    expect(existsSync(resolve(root, "runtime/src/commands/memory/index.ts"))).toBe(
      true,
    );
    expect(existsSync(resolve(root, "runtime/src/commands/memory/memory.tsx"))).toBe(
      true,
    );
    const registry = readFileSync(
      resolve(root, "runtime/src/commands/registry.ts"),
      "utf8",
    );
    expect(registry).toContain('from "./memory/index.js"');
  });
});
