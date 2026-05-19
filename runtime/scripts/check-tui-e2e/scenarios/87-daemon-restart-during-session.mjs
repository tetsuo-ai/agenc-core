/**
 * Daemon restart during an open TUI session.
 *
 * This catches the production failure: user opens agenc, submits a
 * turn, the daemon restarts (crashed, upgraded, or another tool ran
 * `daemon restart`), user submits a second turn → TUI rejects with
 * "Daemon connection is closed" because the persistent client's
 * socket pointer is to a dead process and has no reconnect logic.
 *
 * The scenario:
 *   1. start TUI, type "hi", wait for reply
 *   2. external `daemon restart` kicks the user's old daemon process
 *   3. type "and again" → assert TUI either reconnects OR surfaces a
 *      clean error (not an unhandled rejection or stack-trace dump)
 *
 * SKIPPED today — the persistent client (agent-cli.ts ~line 792) has
 * no auto-reconnect path. Filed as GAP-DMN-PERSISTENT-RECONNECT.
 * Unskip when reconnect (or graceful-error-with-retry) lands.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(SCRIPT_DIR, "..", "..", "..");
const BIN_AGENC = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");

export const meta = {
  description:
    "TUI survives a daemon restart between turns (or fails cleanly).",
  args: ["--yolo"],
  timeoutMs: 240_000,
  slimCwd: true,
  skip: "blocked on persistent-client auto-reconnect — see GAP-DMN-PERSISTENT-RECONNECT",
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForIdle({ timeout: 60_000 });

  // Restart the daemon out-of-band — same operation that any external
  // tool, upgrade script, or `agenc daemon restart` invocation would
  // perform.
  spawnSync(process.execPath, [BIN_AGENC, "daemon", "restart"], {
    encoding: "utf8",
    timeout: 30_000,
  });

  await session.type("and again");
  await session.submit();
  // The TUI must either: (a) reconnect transparently and stream a
  // reply, or (b) surface a clean reconnecting/retry message. It must
  // NOT throw an unhandled rejection visible in the captured PTY.
  await session.waitForIdle({ timeout: 90_000 });
  // No 'Error:' or 'unhandled' or stack-trace markers in the output.
  if (/Error:|UnhandledPromiseRejection|at Object\.request/.test(session.text)) {
    throw new Error(
      "TUI emitted unhandled error during daemon-restart recovery",
    );
  }
}
