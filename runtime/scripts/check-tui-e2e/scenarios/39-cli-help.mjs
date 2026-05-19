/**
 * `agenc --help` scenario.
 *
 * Prints usage to stdout, exits 0. Should NOT spin up the TUI.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

export const meta = {
  description: "agenc --help prints usage and exits cleanly.",
  timeoutMs: 10_000,
};

export default async function () {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_AGENC, "--help"], {
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
      `--help exited ${result.code}; stderr: ${result.stderr.slice(0, 200)}`,
    );
  }
  // Standard usage outputs include one of these markers.
  if (!/usage|Usage|Commands|Options/.test(result.stdout)) {
    throw new Error(`--help stdout has no usage marker: "${result.stdout.slice(0, 200)}"`);
  }
}
