/**
 * /color scenario.
 *
 * `/color` is an immediate command that sets the prompt-bar color for the
 * current session. Smoke-test that typing it doesn't crash and the TUI
 * returns to idle.
 */
export const meta = {
  description: "/color sets prompt color, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/color");
  await session.waitForIdle({ timeout: 15_000 });
}
