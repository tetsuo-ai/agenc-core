/**
 * `agenc --no-tui '<prompt>'` scenario.
 *
 * The --no-tui flag is documented as forcing the daemon-backed
 * one-shot path even inside a TTY. Verify it works and produces
 * model output to stdout.
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
  description: "--no-tui forces daemon one-shot path; produces stdout.",
  timeoutMs: 120_000,
  useTempHome: true,
  slimCwd: true,
};

export default async function (session) {
  const { home, wsPort } = await createTempHome();
  await trustProjectForHome(home, session.cwd);
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [BIN_AGENC, "--no-tui", "reply with the single word NOTUI"],
        {
          cwd: session.cwd,
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
        reject(new Error("--no-tui exceeded timeout"));
      }, 110_000).unref();
    });
    if (result.code !== 0) {
      throw new Error(
        `--no-tui exited code=${result.code}; stderr: ${result.stderr.slice(0, 400)}`,
      );
    }
    if (result.stdout.trim().length === 0) {
      throw new Error(
        `--no-tui produced no stdout; stderr: ${result.stderr.slice(0, 400)}`,
      );
    }
  } finally {
    await teardownTempHome(home);
  }
}
