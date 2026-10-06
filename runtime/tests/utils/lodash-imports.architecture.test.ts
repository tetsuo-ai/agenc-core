import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [path] : [];
  });
}

describe("lodash-es imports", () => {
  it("use one module per function, never the package entry", () => {
    // lodash-es stays external to the bundle. Its package entry re-exports
    // every function, so one import of it loads about 640 modules at startup.
    const barrel = /from\s+["']lodash-es["']|import\(\s*["']lodash-es["']\s*\)|require\(\s*["']lodash-es["']\s*\)/;
    const offenders = sourceFiles(SRC)
      .filter((file) => barrel.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length));
    expect(offenders).toEqual([]);
  });
});
