#!/usr/bin/env node
/**
 * Write `runtime/dist/VERSION` containing { commit, buildTime, runtimeVersion }
 * so the daemon can print a startup banner that proves which build is running.
 *
 * This script also copies runtime assets that must sit beside the built chunks.
 */

import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = path.join(runtimeDir, "bin");
const distDir = path.join(runtimeDir, "dist");
const versionPath = path.join(distDir, "VERSION");
const policySourceDir = path.join(runtimeDir, "src/sandbox/engine/policies");
const bundledRuntimePolicyDir = path.join(distDir, "policies");
const linuxLauncherPolicyDir = path.join(distDir, "sandbox/linux-launcher/policies");
const yoloClassifierPromptSourceDir = path.join(
  runtimeDir,
  "src/utils/permissions/yolo-classifier-prompts",
);
const yoloClassifierPromptDistDir = path.join(
  distDir,
  "yolo-classifier-prompts",
);

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

async function main() {
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }
  writePackageBinShims();
  if (existsSync(policySourceDir)) {
    for (const policyTargetDir of [
      bundledRuntimePolicyDir,
      linuxLauncherPolicyDir,
    ]) {
      mkdirSync(policyTargetDir, { recursive: true });
      cpSync(policySourceDir, policyTargetDir, { recursive: true });
    }
  }
  if (existsSync(yoloClassifierPromptSourceDir)) {
    mkdirSync(yoloClassifierPromptDistDir, { recursive: true });
    cpSync(yoloClassifierPromptSourceDir, yoloClassifierPromptDistDir, {
      recursive: true,
    });
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

function writePackageBinShims() {
  const shims = new Map([
    ["agenc", "#!/usr/bin/env node\nimport \"../dist/bin/agenc.js\";\n"],
    [
      "agenc-linux-sandbox",
      "#!/usr/bin/env node\nimport \"../dist/sandbox/linux-launcher/main.js\";\n",
    ],
  ]);

  mkdirSync(binDir, { recursive: true });
  for (const [name, source] of shims) {
    const shimPath = path.join(binDir, name);
    if (!existsSync(shimPath) || readFileSync(shimPath, "utf8") !== source) {
      writeFileSync(shimPath, source, { encoding: "utf8", mode: 0o755 });
    }
    if ((lstatSync(shimPath).mode & 0o777) !== 0o755) chmodSync(shimPath, 0o755);
  }
}

main().catch((error) => {
  console.error("[build] failed to write VERSION:", error);
  process.exitCode = 1;
});
