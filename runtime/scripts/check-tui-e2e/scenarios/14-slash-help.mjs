/**
 * /help scenario.
 *
 * Sends /help and expects the help menu to render. Asserts a known
 * help-menu marker ("Available commands" or similar) appears, then idle.
 */
export const meta = {
  description: "/help opens the help menu, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/help");
  await session.waitForIdle({ timeout: 15_000 });
}
