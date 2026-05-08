/**
 * /usage scenario.
 *
 * Shows the user's current AgenC usage / billing surface. Smoke-test that
 * the command loads, renders something, and returns to idle.
 */
export const meta = {
  description: "/usage renders usage, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/usage");
  await session.waitForIdle({ timeout: 15_000 });
}
