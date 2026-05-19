/**
 * /export scenario.
 *
 * `/export` exports the current conversation. With no filename argument
 * the command opens its UI; the smoke test just verifies it loads and
 * returns to idle without crashing.
 */
export const meta = {
  description: "/export opens export UI, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/export");
  await session.waitForIdle({ timeout: 15_000 });
}
