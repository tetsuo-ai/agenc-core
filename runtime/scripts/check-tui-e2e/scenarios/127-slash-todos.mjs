/**
 * /todos scenario.
 *
 * Read-only view of the session todo lists. A fresh session has no
 * TodoWrite state, so the command should print the friendly empty state
 * and return to idle.
 */
export const meta = {
  description: "/todos prints the empty todo state and returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/todos");
  await session.waitFor(/No todos recorded this session/, { timeout: 15_000 });
  await session.waitForIdle({ timeout: 15_000 });
}
