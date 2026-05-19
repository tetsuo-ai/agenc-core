/**
 * /rename scenario.
 *
 * `/rename` is immediate. With no argument it opens its rename UI; with
 * one it sets the conversation name. Smoke-test that typing it without
 * args doesn't crash.
 */
export const meta = {
  description: "/rename opens rename UI, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/rename");
  await session.waitForIdle({ timeout: 15_000 });
}
