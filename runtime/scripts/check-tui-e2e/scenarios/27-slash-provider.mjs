/**
 * /provider scenario (alias for /model-provider).
 *
 * Lists providers. Read-only; should idle without crash.
 */
export const meta = {
  description: "/provider lists providers and returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/provider");
  await session.waitForIdle({ timeout: 15_000 });
}
