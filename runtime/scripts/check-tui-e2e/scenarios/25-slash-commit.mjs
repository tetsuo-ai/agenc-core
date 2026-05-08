/**
 * /commit scenario.
 *
 * Creates a git commit. Run from a repo where there are no staged changes
 * — should report "nothing to commit" and idle, not crash. This scenario
 * only asserts no crash.
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
