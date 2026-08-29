import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sourceFiles(root: string): readonly string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = `${root}/${entry}`;
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

function definitionOwners(pattern: RegExp): readonly string[] {
  return sourceFiles(SRC)
    .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"))
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path));
}

describe("LLM config authority", () => {
  test("keeps the deleted LLM config copy gone", () => {
    expect(existsSync(`${SRC}/llm/_deps/config.ts`)).toBe(false);

    const staleImports = sourceFiles(SRC)
      .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"))
      .filter((path) => /llm\/_deps\/config|\.\/_deps\/config/u.test(
        readFileSync(path, "utf8"),
      ))
      .map((path) => relative(SRC, path));
    expect(staleImports).toEqual([]);
  });

  test("has one catalog builder and one disambiguation implementation", () => {
    expect(
      definitionOwners(/function\s+buildProviderModelCatalog\s*\(/u),
    ).toEqual(["config/provider-model-authority.ts"]);
    expect(
      definitionOwners(/function\s+resolveModelDisambiguated\s*\(/u),
    ).toEqual(["config/schema.ts"]);
    expect(
      definitionOwners(/function\s+resolveProviderModelLayer\s*\(/u),
    ).toEqual(["config/provider-model-authority.ts"]);
    expect(
      definitionOwners(/function\s+resolveDisambiguatedModelSelection\s*\(/u),
    ).toEqual([]);
  });
});
