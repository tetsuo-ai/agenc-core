/**
 * /tasks scenario.
 *
 * `/tasks` (alias /bashes) lists and manages background tasks. Smoke-test
 * that the command loads its UI and the TUI returns to idle.
 */
export const meta = {
  description: "/tasks lists background tasks UI, returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/tasks");
  await session.waitForIdle({ timeout: 15_000 });
}
