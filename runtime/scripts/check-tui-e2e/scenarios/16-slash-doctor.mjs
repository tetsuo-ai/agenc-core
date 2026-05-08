/**
 * /doctor scenario.
 *
 * Runs the diagnostic command. Reports daemon/permission/keybinding state
 * etc. Should render report without crash.
 */
export const meta = {
  description: "/doctor prints diagnostic report and returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/doctor");
  await session.waitForIdle({ timeout: 15_000 });
}
