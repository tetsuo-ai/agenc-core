/**
 * `agenc daemon stop` then `daemon status` returns stopped.
 *
 * Catches: stop command leaves the daemon zombie, status command
 * misreports state after stop.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnSyncAgenc(args, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_AGENC, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
    setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${args.join(" ")} timeout`));
    }, timeoutMs).unref();
  });
}

export const meta = {
  description: "daemon stop → status reports stopped, then start works.",
  timeoutMs: 30_000,
};

export default async function () {
  // Stop
  await spawnSyncAgenc(["daemon", "stop"]);
  await sleep(1_000);
  // Status should report stopped (exit non-zero or message)
  const stoppedStatus = await spawnSyncAgenc(["daemon", "status"]);
  if (stoppedStatus.code === 0 && /running/.test(stoppedStatus.stdout)) {
    throw new Error(
      `daemon status shows running after stop: ${stoppedStatus.stdout}`,
    );
  }
  // Start back up so the rest of the gate keeps working.
  const startResult = await spawnSyncAgenc(["daemon", "start"]);
  if (startResult.code !== 0) {
    throw new Error(`daemon start failed: ${startResult.stderr}`);
  }
  await sleep(5_000);
  const runStatus = await spawnSyncAgenc(["daemon", "status"]);
  if (!/running/.test(runStatus.stdout)) {
    throw new Error(`daemon didn't restart cleanly: ${runStatus.stdout}`);
  }
}
