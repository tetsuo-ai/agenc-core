/**
 * /vim scenario.
 *
 * Toggles vim mode. Toggle on, then toggle off (so the test leaves the
 * config in the state it found). The toggle should not crash.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "/vim toggles editing mode in/out without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/vim");
  await session.waitForIdle({ idleWindow: 1_500, timeout: 10_000 });
  await sleep(200);
  // Toggle back to leave the config alone.
  await session.submitSlashCommand("/vim");
  await session.waitForIdle({ idleWindow: 1_500, timeout: 10_000 });
}
