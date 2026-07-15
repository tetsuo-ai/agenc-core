// Release version contract.
//
// The release workflow gates on the tag matching runtime/package.json, and
// `agenc update` compares the manifest's runtimeVersion against the compiled
// VERSION constant — so package.json and version.ts drifting apart would ship
// a runtime that misreports itself and re-downloads forever. The 0.2.0 cut
// also left the runtime version hand-copied into the MCP client infos and the
// rollout store; this pins that those sites import VERSION instead.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { VERSION } from "../../src/version.js";

const RUNTIME_ROOT = resolve(process.cwd());

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...tsFilesUnder(path));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

describe("release version contract", () => {
  test("root, runtime, and launcher release versions match", () => {
    const repoRoot = resolve(RUNTIME_ROOT, "..");
    const versions = [
      join(repoRoot, "package.json"),
      join(repoRoot, "runtime", "package.json"),
      join(repoRoot, "packages", "agenc", "package.json"),
    ].map((path) => JSON.parse(readFileSync(path, "utf8")).version as string);
    expect(new Set(versions).size).toBe(1);
  });

  test("version.ts matches runtime/package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(RUNTIME_ROOT, "package.json"), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  test("no source hardcodes the runtime version outside version.ts", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(join(RUNTIME_ROOT, "src"))) {
      if (file.endsWith(join("src", "version.ts"))) continue;
      const content = readFileSync(file, "utf8");
      for (const [i, line] of content.split("\n").entries()) {
        // The runtime's own version must come from the VERSION constant:
        // anything identifying as agenc-runtime, and the rollout store's
        // agencVersion field, may not carry a semver literal.
        if (
          /agencVersion:\s*["'][0-9]+\.[0-9]+\.[0-9]+/.test(line) ||
          (/name:\s*["']agenc-runtime["']/.test(line) &&
            /version:\s*["'][0-9]+\.[0-9]+\.[0-9]+/.test(line))
        ) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
