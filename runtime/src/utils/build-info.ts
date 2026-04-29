/**
 * Reads `runtime/dist/VERSION` (written by `scripts/write-build-version.mjs`)
 * so the daemon can prove which build is running. This is the verification
 * primitive for Cut 6.2.
 *
 * The file lives next to the running daemon entry point at
 * `<runtimeRoot>/dist/VERSION`. We resolve via `process.argv[1]` so the
 * lookup works in both the CJS and ESM tsup outputs without depending on
 * `import.meta.url` (which the CJS build forbids).
 *
 * @module
 */

import { readFileSync } from "node:fs";
import path from "node:path";

interface BuildInfo {
  readonly commit: string;
  readonly shortCommit: string;
  readonly buildTime: string;
  readonly runtimeVersion: string;
  /** Absolute path of the loaded VERSION file, or null if not found. */
  readonly versionPath: string | null;
}

const UNKNOWN_BUILD_INFO: BuildInfo = {
  commit: "unknown",
  shortCommit: "unknown",
  buildTime: "unknown",
  runtimeVersion: "unknown",
  versionPath: null,
};

let cached: BuildInfo | null = null;

/**
 * Locate the dist directory containing the running daemon entry point.
 * The daemon is launched as `<runtimeRoot>/dist/bin/daemon.js`, so the
 * dist dir is two parents up. Falls back to a `dist` sibling of cwd if
 * argv[1] is unavailable (e.g., REPL context).
 */
function resolveDistDir(): string | null {
  const entry = process.argv[1];
  if (typeof entry === "string" && entry.length > 0) {
    let current = path.dirname(entry);
    for (let i = 0; i < 6; i++) {
      if (path.basename(current) === "dist") {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  // Source-tree fallback for tests / dev: <cwd>/dist if it exists.
  return path.join(process.cwd(), "dist");
}

export function readBuildInfo(): BuildInfo {
  if (cached) return cached;
  const distDir = resolveDistDir();
  if (!distDir) {
    cached = UNKNOWN_BUILD_INFO;
    return cached;
  }
  const versionPath = path.join(distDir, "VERSION");
  try {
    const raw = readFileSync(versionPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    cached = {
      commit: typeof parsed.commit === "string" ? parsed.commit : "unknown",
      shortCommit:
        typeof parsed.shortCommit === "string"
          ? parsed.shortCommit
          : typeof parsed.commit === "string"
            ? parsed.commit.slice(0, 12)
            : "unknown",
      buildTime:
        typeof parsed.buildTime === "string" ? parsed.buildTime : "unknown",
      runtimeVersion:
        typeof parsed.runtimeVersion === "string"
          ? parsed.runtimeVersion
          : "unknown",
      versionPath,
    };
  } catch {
    cached = { ...UNKNOWN_BUILD_INFO, versionPath };
  }
  return cached;
}

export function formatBuildBanner(
  info: BuildInfo,
  context: { configPath?: string; entryPath?: string } = {},
): string {
  const lines: string[] = [
    "[agenc-runtime] starting",
    `  commit:  ${info.shortCommit}`,
    `  build:   ${info.buildTime}`,
    `  version: ${info.runtimeVersion}`,
  ];
  if (context.entryPath) lines.push(`  entry:   ${context.entryPath}`);
  if (context.configPath) lines.push(`  config:  ${context.configPath}`);
  if (info.versionPath) lines.push(`  version-file: ${info.versionPath}`);
  return lines.join("\n");
}
