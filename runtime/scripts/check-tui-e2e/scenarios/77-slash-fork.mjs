/**
 * /fork scenario.
 *
 * `/fork` clones the current conversation off this point so the user can
 * branch the dialog. Smoke-test that the command loads + idles without
 * crashing the Ink tree.
 */
export const meta = {
  description: "/fork forks conversation, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/fork");
  await session.waitForIdle({ timeout: 15_000 });
}
