/**
 * /commit scenario.
 *
 * Runs in the runner-owned clean git fixture, so it can never consume or
 * commit changes staged in the source checkout. It should report "nothing to
 * commit" and idle, not crash.
 */
export const meta = {
  description: "/commit handles no-staged-changes gracefully without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/commit");
  await session.waitForIdle({ timeout: 15_000 });
}
