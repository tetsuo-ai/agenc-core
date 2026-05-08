/**
 * `agenc --resume <unknown-id>` scenario.
 *
 * Catches: resume path in a non-TTY context exits cleanly instead of
 * hanging on Ink waiting for stdin input that will never arrive.
 *
 * In a TTY the resume path mounts the Ink TUI and surfaces "session not
 * found" through the resumeTUI return code. In a piped/non-TTY context
 * (the only context this E2E harness exercises), classifyCLI now refuses
 * the resume path with a clear error and exits non-zero. The TTY path is
 * not exercised here because spawning a real PTY just to verify that
 * exact error message would re-do work the resumeTUI unit tests already
 * cover; this scenario gates the non-TTY hang regression.
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
  if (!/requires an interactive terminal|not found/i.test(result.stderr + result.stdout)) {
    throw new Error(
      `expected resume-non-tty error in output; got stderr=${result.stderr.slice(0, 200)} stdout=${result.stdout.slice(0, 200)}`,
    );
  }
}
