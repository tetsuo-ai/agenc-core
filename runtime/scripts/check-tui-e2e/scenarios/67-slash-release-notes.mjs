/**
 * /release-notes scenario.
 *
 * Shows the AgenC release notes. Read-only smoke test that verifies the
 * command loads and exits cleanly.
 */
export const meta = {
  description: "/release-notes renders, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/release-notes");
  await session.waitForIdle({ timeout: 15_000 });
}
