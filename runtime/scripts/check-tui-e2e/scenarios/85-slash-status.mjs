/**
 * /status scenario.
 *
 * Shows runtime/session status. Smoke-test that the command loads + idles.
 */
export const meta = {
  description: "/status renders session status, returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/status");
  await session.waitForIdle({ timeout: 15_000 });
}
