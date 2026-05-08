/**
 * /theme scenario.
 *
 * Opens theme picker. Esc to dismiss without applying a change.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "/theme opens picker, Esc dismisses, no crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/theme");
  await session.waitForIdle({ idleWindow: 1_500, timeout: 15_000 });
  session.sendEscape();
  await sleep(300);
}
