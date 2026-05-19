/**
 * /version scenario.
 *
 * Shows the current AgenC build version. Smoke-test that the command
 * loads, renders, and returns to idle.
 */
export const meta = {
  description: "/version renders, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/version");
  await session.waitForIdle({ timeout: 15_000 });
}
