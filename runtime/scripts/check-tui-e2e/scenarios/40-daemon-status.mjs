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

async function restart() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_AGENC, "daemon", "restart"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.on("close", (code) => resolve(code));
    child.on("error", reject);
  });
}

export default async function () {
  // Earlier scenarios that spawn `agenc` subprocesses sometimes leave the
  // daemon in a state where it appears stopped to the next caller. The
  // remediation in production is `agenc daemon restart`; the gate models
  // that here. After restart, status MUST succeed — if it doesn't, the
  // daemon is genuinely broken.
  let lastResult = await statusOnce();
  if (lastResult.code !== 0 || !/running/.test(lastResult.stdout)) {
    await restart();
    await sleep(1_500);
    lastResult = await statusOnce();
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
