/**
 * `agenc --resume <unknown-id>` scenario.
 *
 * Catches: resume path with a non-existent session ID returns a clean
 * "session not found" error and exits, doesn't crash or hang.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

export const meta = {
  description: "agenc --resume <bogus> exits cleanly with not-found message.",
  timeoutMs: 20_000,
};

export default async function () {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BIN_AGENC, "--resume", "session-that-does-not-exist-7c3f"],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
    setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("--resume exceeded timeout"));
    }, 18_000).unref();
  });
  if (result.code === 0) {
    throw new Error(`expected non-zero exit for bogus --resume, got 0`);
  }
  if (!/session not found|not found/i.test(result.stderr + result.stdout)) {
    throw new Error(
      `expected 'session not found' in output; got stderr=${result.stderr.slice(0, 200)} stdout=${result.stdout.slice(0, 200)}`,
    );
  }
}
