/**
 * /<garbage> scenario.
 *
 * Submits a slash command that doesn't exist. Expects the TUI to handle
 * gracefully (some kind of "unknown command" message, or silent no-op,
 * not a crash).
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "Unknown slash command produces no crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  // /xyzzy is not a real slash command. Type it, dismiss the picker, send
  // Enter. The TUI either reports "Unknown command" or silently no-ops;
  // either is acceptable here. The assertion is that no crash pattern
  // hits the captured buffer.
  await session.type("/xyzzy");
  session.sendEscape();
  await sleep(80);
  session.send("\r");
  await session.waitForIdle({ timeout: 15_000 });
}
