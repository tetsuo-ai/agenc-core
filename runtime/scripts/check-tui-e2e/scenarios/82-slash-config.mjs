/**
 * /config scenario.
 *
 * Opens the in-TUI config editor. Smoke-test that the command loads +
 * idles without crashing.
 */
export const meta = {
  description: "/config opens config editor, returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/config");
  await session.waitForIdle({ timeout: 15_000 });
}
