/**
 * /sandbox scenario.
 *
 * `/sandbox` is the sandbox-toggle command. Without arguments it should
 * either show its help/status or open its UI. Smoke-test the command
 * loads + idles without crashing.
 */
export const meta = {
  description: "/sandbox toggle UI loads, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/sandbox");
  await session.waitForIdle({ timeout: 15_000 });
}
