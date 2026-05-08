/**
 * `agenc daemon status` scenario.
 *
 * Should report the running daemon's PID. Catches: status command
 * regressions, daemon discovery via daemon.pid file, peer auth race
 * during status query.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

export const meta = {
  description: "agenc daemon status reports running PID.",
  timeoutMs: 10_000,
};

export default async function () {
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
  if (result.code !== 0) {
    throw new Error(
      `daemon status exited ${result.code}; stderr: ${result.stderr.slice(0, 200)}`,
    );
  }
  if (!/running/.test(result.stdout)) {
    throw new Error(
      `daemon status did not report running: "${result.stdout}"`,
    );
  }
  if (!/pid\s+\d+/.test(result.stdout)) {
    throw new Error(
      `daemon status did not include PID: "${result.stdout}"`,
    );
  }
}
