import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../../src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry)
        ? [path]
        : [];
  });
}

describe("compact progress authority", () => {
  test("uses progress events without a parallel SDK status setter", () => {
    const offenders = sourceFiles(sourceRoot).flatMap((path) =>
      /\bsetSDKStatus\b/u.test(readFileSync(path, "utf8"))
        ? [relative(sourceRoot, path).replaceAll("\\", "/")]
        : [],
    );

    expect(offenders).toEqual([]);

    const compactService = readFileSync(
      resolve(sourceRoot, "services/compact/compact.ts"),
      "utf8",
    );
    expect(compactService).toContain('type: "hooks_start"');
    expect(compactService).toContain('type: "compact_start"');
    expect(compactService).toContain('type: "compact_end"');
  });
});
