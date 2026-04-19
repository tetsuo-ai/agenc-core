#!/usr/bin/env node
/**
 * Write `runtime/dist/VERSION` containing { commit, buildTime, runtimeVersion }
 * so the daemon can print a startup banner that proves which build is running.
 *
 * Cut 6.2 of the AgenC runtime refactor (TODO.MD).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(runtimeDir, "dist");
const versionPath = path.join(distDir, "VERSION");

function tryGitRevParse() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: runtimeDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0 && result.stdout) {
    return result.stdout.trim();
  }
  return null;
}

function readRuntimePackageVersion() {
  try {
    const packageJsonPath = path.join(runtimeDir, "package.json");
    const raw = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:fs").readFileSync(packageJsonPath, "utf8"),
    );
    return typeof raw.version === "string" ? raw.version : "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  const commit = process.env.AGENC_BUILD_COMMIT ?? tryGitRevParse() ?? "unknown";
  const shortCommit = commit === "unknown" ? "unknown" : commit.slice(0, 12);
  const buildTime = process.env.AGENC_BUILD_TIME ?? new Date().toISOString();

  // Read package.json synchronously without dynamic require so this script
  // works under both CJS and ESM resolution.
  const packageJsonPath = path.join(runtimeDir, "package.json");
  let runtimeVersion = "unknown";
  try {
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof raw.version === "string") {
      runtimeVersion = raw.version;
    }
  } catch {
    // best-effort
  }

  const payload = {
    commit,
    shortCommit,
    buildTime,
    runtimeVersion,
  };

  writeFileSync(versionPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    `[build] wrote ${path.relative(runtimeDir, versionPath)}: ` +
      `${runtimeVersion} @ ${shortCommit} (${buildTime})`,
  );
}

main().catch((error) => {
  console.error("[build] failed to write VERSION:", error);
  process.exitCode = 1;
});
