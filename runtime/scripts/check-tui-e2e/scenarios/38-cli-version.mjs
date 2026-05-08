/**
 * `agenc --version` scenario.
 *
 * Prints version string to stdout, exits 0. Catches: version-flag
 * regressions, runtime-side init that runs even on --version (it
 * shouldn't), wrapper-vs-runtime version drift.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

export const meta = {
  description: "agenc --version prints semver and exits cleanly.",
  timeoutMs: 10_000,
};

export default async function () {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_AGENC, "--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
  if (result.code !== 0) {
    throw new Error(
      `--version exited ${result.code}; stderr: ${result.stderr.slice(0, 200)}`,
    );
  }
  // Expect a number-dot-number-dot-number anywhere in stdout.
  if (!/\d+\.\d+\.\d+/.test(result.stdout)) {
    throw new Error(`--version stdout did not contain semver: "${result.stdout}"`);
  }
}
