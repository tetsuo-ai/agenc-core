/**
 * /skills scenario.
 *
 * Lists available skills. Smoke-test that the command loads, renders,
 * and returns to idle.
 */
export const meta = {
  description: "/skills renders skill list, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/skills");
  await session.waitForIdle({ timeout: 15_000 });
}
