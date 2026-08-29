/**
 * Daemon restart during an open TUI session.
 *
 * This guards against a fixed production failure: user opens agenc, submits a
 * turn, the daemon restarts (crashed, upgraded, or another tool ran
 * `daemon restart`), and the TUI's persistent client must reconnect before
 * the user submits a second turn.
 *
 * The scenario:
 *   1. start TUI, type "hi", wait for reply
 *   2. external `daemon restart` kicks the user's old daemon process
 *   3. type "and again" → assert TUI either reconnects OR surfaces a
 *      clean error (not an unhandled rejection or stack-trace dump)
 *
 * Persistent-client reconnect support is implemented, so this scenario stays
 * enabled as end-to-end regression coverage.
 */
export const meta = {
  description:
    "TUI survives a daemon restart between turns (or fails cleanly).",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  timeoutMs: 240_000,
  slimCwd: true,
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
  await session.restartGateDaemon();

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
