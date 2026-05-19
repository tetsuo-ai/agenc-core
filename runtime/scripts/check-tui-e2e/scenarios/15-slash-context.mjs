/**
 * /context scenario.
 *
 * Reports current context-window usage. Should render summary stats and
 * return to idle without crash.
 */
export const meta = {
  description: "/context renders usage report and returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/context");
  await session.waitForIdle({ timeout: 15_000 });
}
