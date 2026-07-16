/**
 * Print mode + --yolo scenario.
 *
 * --yolo + -p should print and exit. Catches yolo-specific print-mode
 * regressions (permission elision, status-line drift in headless mode).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTempHome,
  tempDaemonEnv,
  teardownTempHome,
  trustProjectForHome,
} from "../harness.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

export const meta = {
  description: "agenc --yolo -p prints model reply and exits cleanly.",
  timeoutMs: 90_000,
};

export default async function () {
  const { home, wsPort } = await createTempHome();
  await trustProjectForHome(home, process.cwd());
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [BIN_AGENC, "--yolo", "-p", "say only the word HELLO and nothing else"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: tempDaemonEnv(home, wsPort),
        },
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
    // Strip the noisy config-migration banner so the assertion error
    // surfaces the actual cause.
    const cleanStderr = result.stderr
      .split("\n")
      .filter((line) => !line.includes("[agenc:config-migration]"))
      .join("\n");
    if (result.code !== 0) {
      throw new Error(
        `yolo print mode exited code=${result.code}; stderr: ${cleanStderr.slice(0, 600)}`,
      );
    }
    if (result.stdout.trim().length === 0) {
      throw new Error(
        `yolo print mode produced no stdout; stderr: ${cleanStderr.slice(0, 600)}`,
      );
    }
  } finally {
    await teardownTempHome(home);
  }
}
