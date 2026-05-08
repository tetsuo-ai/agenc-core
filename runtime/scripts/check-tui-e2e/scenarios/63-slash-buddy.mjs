/**
 * /buddy scenario.
 *
 * `/buddy` is the AgenC companion command. With no argument it shows
 * status/help. Smoke-test that the command loads, renders, and returns
 * to idle without crashing the Ink tree.
 */
export const meta = {
  description: "/buddy companion UI loads + idles without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/buddy");
  await session.waitForIdle({ timeout: 15_000 });
}
