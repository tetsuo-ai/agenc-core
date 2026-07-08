/**
 * /plugins scenario.
 *
 * Opens the interactive plugin manager menu (enable/disable, uninstall,
 * marketplace install). Smoke-test that the menu renders its title and
 * that q closes it back to the idle prompt.
 */
export const meta = {
  description: "/plugins opens the plugin menu and q closes it back to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/plugins");
  await session.waitFor(/PLUGINS/, { timeout: 15_000 });

  session.send("q");
  await session.waitForIdle({ timeout: 15_000 });
}
