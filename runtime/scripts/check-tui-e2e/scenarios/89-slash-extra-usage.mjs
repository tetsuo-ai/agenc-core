/**
 * /extra-usage scenario.
 *
 * Smoke-test that typing /extra-usage at the prompt does not crash the Ink
 * tree, regardless of whether the command's gate evaluates to enabled
 * for this build. Hidden / gated commands typically render their help
 * line ("not available in this build", "feature disabled", or similar)
 * and return to idle. Only failure modes here are: the typeahead picker
 * crash, the load-time module crash, or an unhandled exception in the
 * command handler.
 */
export const meta = {
  description: "/extra-usage types/dispatches without crashing Ink.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/extra-usage");
  await session.waitForIdle({ timeout: 15_000 });
}
