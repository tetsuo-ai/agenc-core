/**
 * /init scenario.
 *
 * Generates AGENC.md for the current project. May write a file as a
 * side-effect; we only assert no crash and idle return. Per-scenario
 * temp HOME (Tier C) will let us assert the file content directly.
 */
export const meta = {
  description: "/init runs without crash and returns to idle.",
  timeoutMs: 60_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/init");
  await session.waitForIdle({ timeout: 45_000 });
}
