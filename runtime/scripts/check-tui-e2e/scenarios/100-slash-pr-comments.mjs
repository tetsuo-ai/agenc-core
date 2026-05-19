/**
 * /pr-comments scenario.
 *
 * `/pr-comments` is a prompt-type command that tells the model to fetch
 * comments from a GitHub pull request. With no PR argument it should
 * show its argument prompt rather than dispatching a real fetch.
 * Smoke-test that the command doesn't crash and returns to idle.
 */
export const meta = {
  description: "/pr-comments dispatches without crashing.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/pr-comments");
  await session.waitForIdle({ timeout: 15_000 });
}
