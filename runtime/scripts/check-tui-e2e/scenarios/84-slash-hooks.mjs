/**
 * /hooks scenario.
 *
 * Opens the hooks editor (pre/post-tool hooks). Smoke-test that the
 * command loads + idles without crashing.
 */
export const meta = {
  description: "/hooks opens hooks editor, returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/hooks");
  await session.waitForIdle({ timeout: 15_000 });
}
