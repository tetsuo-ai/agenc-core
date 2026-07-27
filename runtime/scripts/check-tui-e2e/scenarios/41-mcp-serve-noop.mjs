/**
 * `agenc mcp serve` smoke scenario.
 *
 * Spawns `agenc mcp serve` (the MCP server-out path), waits a short
 * window for it to bind, then SIGTERM. Verifies the server starts
 * cleanly without crashing.
 *
 * Per GAP-MCP-02 the `mcp` CLI only supports `serve` today; the other
 * subcommands fail. This scenario validates the one that works.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

export const meta = {
  description: "agenc mcp serve binds without crashing.",
  timeoutMs: 30_000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (session) {
  const child = await session.spawnTracked(
    process.execPath,
    [BIN_AGENC, "mcp", "serve"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let earlyExit = null;
  let childError = null;
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.on("close", (code) => (earlyExit = code));
  child.on("error", (error) => (childError = error));
  // 3 seconds is enough for a bind error to surface.
  await sleep(3_000);
  if (childError !== null) {
    throw childError;
  }
  if (earlyExit !== null && earlyExit !== 0) {
    throw new Error(
      `agenc mcp serve exited early code=${earlyExit}; stderr: ${stderr.slice(0, 400)}`,
    );
  }
  const termination = await session.terminateTrackedChild(child, {
    graceMs: 2_000,
    forceKillGraceMs: 2_000,
  });
  if (termination?.error) {
    throw termination.error;
  }
  // Crash patterns in stderr (the server writes status to stderr).
  if (/Cannot find module|TypeError|ReferenceError|UnhandledPromiseRejection/.test(stderr)) {
    throw new Error(`mcp serve emitted crash pattern: ${stderr.slice(0, 400)}`);
  }
}
