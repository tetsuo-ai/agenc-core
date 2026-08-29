import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(runtimeRoot, "src");
const repositoryRoot = resolve(runtimeRoot, "..");

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

describe("retired profiler surfaces", () => {
  test("does not retain the orphaned headless profiler", () => {
    expect(
      existsSync(resolve(sourceRoot, "utils/headlessProfiler.ts")),
    ).toBe(false);
    expect(
      existsSync(resolve(sourceRoot, "services/api/anthropic.ts")),
    ).toBe(false);
  });

  test("does not retain the orphaned query profiler or its environment switch", () => {
    const retiredSurface =
      /\b(?:queryProfiler|startQueryProfile|queryCheckpoint|endQueryProfile|logQueryProfileReport)\b/u;
    const violations = sourceFiles(sourceRoot)
      .filter((path) => retiredSurface.test(readFileSync(path, "utf8")))
      .map((path) => relative(sourceRoot, path).replaceAll("\\", "/"));
    const envReference = readFileSync(
      resolve(repositoryRoot, "docs/reference/env.md"),
      "utf8",
    );

    expect(existsSync(resolve(sourceRoot, "utils/queryProfiler.ts"))).toBe(false);
    expect(violations).toEqual([]);
    expect(envReference).not.toContain("AGENC_PROFILE_QUERY");
  });

  test("does not retain the inert startup profiler or its private helpers", () => {
    const retiredSurface =
      /\b(?:startupProfiler|profilerBase|profileCheckpoint|profileReport|isDetailedProfilingEnabled|getStartupPerfLogPath)\b/u;
    const violations = sourceFiles(sourceRoot)
      .filter((path) => retiredSurface.test(readFileSync(path, "utf8")))
      .map((path) => relative(sourceRoot, path).replaceAll("\\", "/"));
    const envReference = readFileSync(
      resolve(repositoryRoot, "docs/reference/env.md"),
      "utf8",
    );

    expect(existsSync(resolve(sourceRoot, "utils/startupProfiler.ts"))).toBe(false);
    expect(existsSync(resolve(sourceRoot, "utils/profilerBase.ts"))).toBe(false);
    expect(violations).toEqual([]);
    expect(envReference).not.toContain("AGENC_PROFILE_STARTUP");
  });
});
