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
  await session.waitFor(/AGENTS[\s\S]*registered/, { timeout: 15_000 });
  await session.waitForIdle({ timeout: 15_000 });

  if (/▶/u.test(session.text)) {
    throw new Error("/agents left the main prompt visible while the menu owns input");
  }
}
