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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function statusOnce() {
  return new Promise((resolve, reject) => {
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
}

export default async function () {
  // Earlier scenarios that spawn `agenc` subprocesses can transiently make
  // the daemon look down between their connect/disconnect cycles. Retry
  // a few times before declaring failure; if the daemon is genuinely down
  // we'll see consistent failures.
  let lastResult = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    lastResult = await statusOnce();
    if (lastResult.code === 0 && /running/.test(lastResult.stdout)) break;
    await sleep(500);
  }
  if (lastResult.code !== 0) {
    throw new Error(
      `daemon status exited ${lastResult.code} after retries; stderr: ${lastResult.stderr.slice(0, 200)}`,
    );
  }
  if (!/running/.test(lastResult.stdout)) {
    throw new Error(
      `daemon status did not report running after retries: "${lastResult.stdout}"`,
    );
  }
  if (!/pid\s+\d+/.test(lastResult.stdout)) {
    throw new Error(
      `daemon status did not include PID: "${lastResult.stdout}"`,
    );
  }
}
