/**
 * /memory scenario.
 *
 * Memory CLI surface. May open a sub-UI for editing memory files; here we
 * only assert that invoking it doesn't crash and reaches idle (or stays
 * in a stable interactive state we then exit with Esc).
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "/memory invokes the memory CLI without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/memory");
  await session.waitForIdle({ idleWindow: 1_500, timeout: 15_000 });
  // If the command opened a sub-UI, dismiss it.
  session.sendEscape();
  await sleep(300);
}
