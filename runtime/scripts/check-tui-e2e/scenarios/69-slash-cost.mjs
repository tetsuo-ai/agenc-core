/**
 * /cost scenario.
 *
 * Shows the running cost for this session. Smoke-test that the command
 * loads, renders something, and returns to idle.
 */
export const meta = {
  description: "/cost renders cost, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/cost");
  await session.waitForIdle({ timeout: 15_000 });
}
