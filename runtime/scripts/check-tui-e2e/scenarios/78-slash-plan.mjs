/**
 * /plan scenario.
 *
 * `/plan` toggles or shows the plan-mode UI. Smoke-test that the command
 * loads + idles without crashing.
 */
export const meta = {
  description: "/plan toggles plan UI, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/plan");
  await session.waitForIdle({ timeout: 15_000 });
}
