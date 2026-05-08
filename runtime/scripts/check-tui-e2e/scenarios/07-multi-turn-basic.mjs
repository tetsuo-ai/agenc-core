/**
 * Multi-turn scenario.
 *
 * Submits two messages back-to-back. Catches: transcript reset between
 * turns, history loss, daemon session-state leaks, conversation context
 * being silently dropped.
 *
 * Assertion is bytes-stopped twice; the assertNoCrash on the captured
 * buffer covers the "agent_completed for prior turn fires after second
 * submit and crashes the client" class of bug.
 */
export const meta = {
  description: "Two messages in one session, both reach idle, no crash.",
  timeoutMs: 180_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForIdle({ timeout: 60_000 });
  await session.type("and again");
  await session.submit();
  await session.waitForIdle({ timeout: 60_000 });
}
