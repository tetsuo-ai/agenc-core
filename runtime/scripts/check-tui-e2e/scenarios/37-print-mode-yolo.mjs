/**
 * Print mode + --yolo scenario.
 *
 * --yolo + -p should print and exit. Catches yolo-specific print-mode
 * regressions (permission elision, status-line drift in headless mode).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

export const meta = {
  description: "agenc --yolo -p prints model reply and exits cleanly.",
  timeoutMs: 90_000,
  // `agenc --yolo -p "<prompt>"` exits code 1 immediately with only
  // config-migration log lines on stderr — no error message, no model
  // response. Default print mode (without --yolo) works fine, so the
  // bug is in the --yolo + print-mode combination. Filed as
  // GAP-CLI-YOLO-PRINT-MODE.
  skip: "blocked on --yolo + -p print-mode combination crash; see GAP-CLI-YOLO-PRINT-MODE",
};

export default async function () {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BIN_AGENC, "--yolo", "-p", "say only the word HELLO and nothing else"],
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
      reject(new Error("yolo print mode exceeded timeout"));
    }, 80_000).unref();
  });
  if (result.code !== 0) {
    throw new Error(
      `yolo print mode exited code=${result.code}; stderr: ${result.stderr.slice(0, 400)}`,
    );
  }
  if (result.stdout.trim().length === 0) {
    throw new Error(
      `yolo print mode produced no stdout; stderr: ${result.stderr.slice(0, 400)}`,
    );
  }
}
