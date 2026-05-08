/**
 * /wiki scenario.
 *
 * Looks up wiki/help content. Smoke-test that the command loads + idles
 * without crashing.
 */
export const meta = {
  description: "/wiki loads, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/wiki");
  await session.waitForIdle({ timeout: 15_000 });
}
