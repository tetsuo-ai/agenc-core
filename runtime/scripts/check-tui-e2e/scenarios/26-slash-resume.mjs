/**
 * /resume scenario.
 *
 * /resume without args opens a session picker (or errors on no-sessions).
 * Either path: should not crash. We Esc out of any picker and verify
 * idle return.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "/resume opens picker or reports no sessions, no crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/resume");
  await session.waitForIdle({ idleWindow: 1_500, timeout: 15_000 });
  // Dismiss the picker if it opened.
  session.sendEscape();
  await sleep(300);
}
