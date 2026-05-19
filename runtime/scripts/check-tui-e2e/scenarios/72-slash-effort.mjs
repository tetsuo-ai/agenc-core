/**
 * /effort scenario.
 *
 * `/effort` opens the reasoning-effort selector. Smoke-test that it loads
 * and returns to idle without crashing.
 */
export const meta = {
  description: "/effort opens reasoning-effort UI, returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/effort");
  await session.waitForIdle({ timeout: 15_000 });
}
