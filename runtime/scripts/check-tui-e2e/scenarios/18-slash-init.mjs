/**
 * /init scenario.
 *
 * Generates AGENC.md for the current project. The runner-owned slim cwd keeps
 * that side effect out of the source checkout and is removed with the private
 * scenario state.
 */
export const meta = {
  description: "/init runs without crash and returns to idle.",
  timeoutMs: 60_000,
  slimCwd: true,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/init");
  await session.waitForIdle({ timeout: 45_000 });
}
