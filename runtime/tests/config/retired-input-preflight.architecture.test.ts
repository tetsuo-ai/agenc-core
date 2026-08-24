import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../src/config");

function source(name: string): string {
  return readFileSync(resolve(sourceRoot, name), "utf8");
}

describe("retired config input preflight architecture", () => {
  test("the detector is metadata-only", () => {
    const detector = source("retired-input-preflight.ts");

    expect(detector).toContain('from "node:fs/promises"');
    expect(detector).toMatch(/\b(?:lstat|readdir)\b/u);
    expect(detector).not.toMatch(
      /\b(?:open|readFile|writeFile|rename|rm|unlink|copyFile|parseToml|JSON\.parse)\b/u,
    );
  });

  test("ordinary loading has one retired-input detector", () => {
    const repository = source("repository.ts");
    const store = source("store.ts");
    const loader = source("loader.ts");

    expect(repository.match(/detectRetiredConfigInputs/gu)).toHaveLength(2);
    expect(store).not.toContain("detectRetiredConfigInputs");
    expect(loader).not.toContain("detectRetiredConfigInputs");
    expect(`${store}\n${loader}`).not.toMatch(
      /(?:settings\.json|managed-mcp\.json|keybindings\.json)/u,
    );
  });

  test("migration and ordinary loading share ancestor MCP candidate semantics", () => {
    const detector = source("retired-input-preflight.ts");
    const migration = source("migration.ts");

    expect(detector).toContain(
      "export function retiredProjectMcpJsonCandidates",
    );
    expect(migration).toContain(
      'import { retiredProjectMcpJsonCandidates } from "./retired-input-preflight.js"',
    );
    expect(migration).not.toContain(
      "function retiredProjectMcpJsonCandidates",
    );
  });
});
