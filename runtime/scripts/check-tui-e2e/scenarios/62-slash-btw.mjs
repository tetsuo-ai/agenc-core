/**
 * /btw scenario.
 *
 * `/btw` opens the side-question UI so the user can ask a quick aside
 * without disturbing the main conversation. Smoke-test that typing it
 * doesn't crash and the TUI returns to idle. Don't pass an argument so
 * the command shows its argument prompt rather than dispatching to the
 * model.
 */
export const meta = {
  description: "/btw opens side-question UI, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/btw");
  await session.waitForIdle({ timeout: 15_000 });
}
