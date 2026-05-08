/**
 * /agents scenario.
 *
 * Lists agent configurations. Read-only; should print summary and idle.
 */
export const meta = {
  description: "/agents lists agents and returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/agents");
  await session.waitForIdle({ timeout: 15_000 });
}
