/**
 * `agenc-runtime --version` (or whatever the runtime entry exposes).
 *
 * Verifies the runtime binary exists in the dist and reports a
 * version. Catches build regressions where the runtime entry is
 * missing or fails to import.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

export const meta = {
  description: "agenc-runtime daemon-related entry imports and runs.",
  timeoutMs: 10_000,
};

export default async function () {
  // Use `agenc daemon status` as the smoke — it imports the same daemon
  // surface as `agenc-runtime` (a separate npm bin pointing at a thin
  // wrapper).
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_AGENC, "daemon", "status"], {
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
  // Don't care about the status — care that it didn't crash with
  // a Node-level error. Any code 0 or "stopped/running" output is fine.
  if (/Cannot find module|TypeError|ReferenceError/.test(result.stderr)) {
    throw new Error(`runtime import error: ${result.stderr.slice(0, 400)}`);
  }
}
