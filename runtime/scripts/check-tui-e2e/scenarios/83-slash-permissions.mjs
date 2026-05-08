/**
 * /permissions scenario.
 *
 * Opens the permissions editor (allow/deny rules). Smoke-test that the
 * command loads + idles without crashing.
 */
export const meta = {
  description: "/permissions opens permissions editor, returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/permissions");
  await session.waitForIdle({ timeout: 15_000 });
}
