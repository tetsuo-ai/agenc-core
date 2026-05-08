/**
 * /model scenario (alias /provider, /model-provider).
 *
 * Lists available providers and currently selected model. Read-only when
 * dispatched without args.
 */
export const meta = {
  description: "/model prints provider/model status without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/model");
  await session.waitForIdle({ timeout: 15_000 });
}
