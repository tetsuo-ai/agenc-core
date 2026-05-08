/**
 * Empty-submit scenario.
 *
 * Press Enter on an empty input. Should be a no-op (no message
 * submitted, idle stays). Catches: regression where empty-Enter sends
 * a blank message that confuses the daemon.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "Empty Enter is a no-op, no daemon round-trip.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  session.send("\r");
  await sleep(1_500);
  // No assistant reply, no subagent spawn, no crash.
}
