/**
 * /compact scenario.
 *
 * Triggers manual compaction. May take a while if the model has to
 * summarize. Idle when done. No crash.
 */
export const meta = {
  description: "/compact runs without crash and returns to idle.",
  timeoutMs: 90_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/compact");
  await session.waitForIdle({ timeout: 75_000 });
}
