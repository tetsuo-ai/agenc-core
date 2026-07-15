/**
 * Non-TTY stdin routing scenario.
 *
 * `echo "<prompt>" | agenc` should route through the daemon-backed
 * one-shot path (route.ts: branch 4). Verifies stdin-piped input
 * doesn't crash and produces output.
 *
 * The actual routing (non-TTY → oneShotCLI) is fast and deterministic.
 * The slow part is the model — qwen3.6 + LMStudio takes anywhere from
 * <1s on a warm cache to 200s+ on cold prefix-cache invalidation. The
 * timeout below has to swallow the worst-case model latency, otherwise
 * the gate flakes when the daemon's KV cache evicts between scenarios.
 * The route's correctness is also covered by check-llm-pipeline scenario
 * 03 (which inspects the rollout for the routing decision regardless of
 * how slow the model responds).
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

const TIMEOUT_MS = 240_000;

export const meta = {
  description: "Piped stdin (no TTY) routes through one-shot CLI path.",
  timeoutMs: TIMEOUT_MS + 30_000,
  useTempHome: true,
  slimCwd: true,
};

export default async function (session) {
  const { home, wsPort } = await createTempHome();
  await trustProjectForHome(home, session.cwd);
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN_AGENC], {
        cwd: session.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: tempDaemonEnv(home, wsPort),
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
      }, TIMEOUT_MS).unref();
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
  } finally {
    await teardownTempHome(home);
  }
}
