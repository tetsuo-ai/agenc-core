/**
 * Non-TTY stdin routing scenario.
 *
 * `echo "<prompt>" | agenc` should route through the daemon-backed
 * one-shot path (route.ts: branch 4). Verifies stdin-piped input
 * doesn't crash and produces output.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

export const meta = {
  description: "Piped stdin (no TTY) routes through one-shot CLI path.",
  timeoutMs: 120_000,
};

export default async function () {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_AGENC], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
    child.stdin.write("reply with the single word PIPED");
    child.stdin.end();
    setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("piped stdin exceeded timeout"));
    }, 110_000).unref();
  });
  if (result.code !== 0) {
    throw new Error(
      `piped stdin exited code=${result.code}; stderr: ${result.stderr.slice(0, 400)}`,
    );
  }
  if (result.stdout.trim().length === 0) {
    throw new Error(
      `piped stdin produced no stdout; stderr: ${result.stderr.slice(0, 400)}`,
    );
  }
}
