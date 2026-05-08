/**
 * /reload-plugins scenario.
 *
 * Reloads the plugin slash-command registry. Useful while developing
 * plugins. Smoke-test that the command runs and returns to idle.
 */
export const meta = {
  description: "/reload-plugins runs, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/reload-plugins");
  await session.waitForIdle({ timeout: 15_000 });
}
