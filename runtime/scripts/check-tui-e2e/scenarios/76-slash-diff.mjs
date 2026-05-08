/**
 * /diff scenario.
 *
 * `/diff` shows pending file changes (or a diff over a range). Smoke-test
 * the command loads + idles without crash.
 */
export const meta = {
  description: "/diff renders diff UI, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/diff");
  await session.waitForIdle({ timeout: 15_000 });
}
