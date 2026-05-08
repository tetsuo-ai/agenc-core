/**
 * /branch scenario.
 *
 * Creates a conversation branch at the current point. With no prior turns
 * the command may print a notice or no-op; either is acceptable as long
 * as it doesn't crash.
 */
export const meta = {
  description: "/branch invokes without crash and returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/branch");
  await session.waitForIdle({ timeout: 15_000 });
}
