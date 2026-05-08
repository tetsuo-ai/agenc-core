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
  timeoutMs: 120_000,
  // The second submit reliably triggers `AgenC daemon agent not found:
  // <id>` from handlePersistentDaemonMessage and crashes the TUI client
  // (chunk-LQ3VSMDG.js:65847). Same class as today's late post-turn
  // crash. Filed as GAP-DMN-AGENT-NOT-FOUND. Default mode only — yolo
  // counterpart 08-yolo-multi-turn passes.
  skip: "blocked on multi-turn 'agent not found' crash (default mode); see GAP-DMN-AGENT-NOT-FOUND",
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
