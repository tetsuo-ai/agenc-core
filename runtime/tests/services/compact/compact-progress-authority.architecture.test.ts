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
    const transaction = readFileSync(
      resolve(sourceRoot, "services/compact/transaction.ts"),
      "utf8",
    );
    expect(transaction).toContain('type: "hooks_start"');
    expect(compactService).toContain('type: "compact_start"');
    expect(compactService).toContain('type: "compact_end"');
  });

  test("keeps lifecycle dispatch and compaction-result projection single-owned", () => {
    const lifecycleCallsites = sourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return ["executePreCompact", "executePostCompact"].flatMap((method) =>
        Array.from(
          source.matchAll(new RegExp(`\\.${method}\\s*\\(`, "gu")),
          () => ({
            method,
            path: relative(sourceRoot, path).replaceAll("\\", "/"),
          }),
        )
      );
    }).sort((left, right) => left.method.localeCompare(right.method));

    expect(lifecycleCallsites).toEqual([
      { method: "executePostCompact", path: "services/compact/transaction.ts" },
      { method: "executePreCompact", path: "services/compact/transaction.ts" },
    ]);

    const obsoleteProjectionOwners = sourceFiles(sourceRoot).flatMap((path) =>
      /\b(?:createHookResults|hookResults)\b/u.test(readFileSync(path, "utf8"))
        ? [relative(sourceRoot, path).replaceAll("\\", "/")]
        : []
    );
    expect(obsoleteProjectionOwners).toEqual([]);
  });
});
