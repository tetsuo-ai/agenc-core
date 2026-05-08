/**
 * /exit scenario.
 *
 * Sends `/exit` and expects the TUI to shut down cleanly within a short
 * grace window. Catches: shutdown handlers that throw, daemon-detach paths
 * that hang, transcript-flush logic that loops.
 *
 * The harness's exitGracefully runs after every scenario as a safety net,
 * but this scenario specifically asserts that /exit by itself causes the
 * PTY to terminate.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "/exit triggers clean shutdown of the TUI.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/exit");
  // Wait up to 8s for the PTY to exit on its own.
  const start = Date.now();
  while (Date.now() - start < 8_000) {
    if (session.exited) return;
    await sleep(100);
  }
  throw new Error("/exit did not cause the TUI to terminate within 8s");
}
