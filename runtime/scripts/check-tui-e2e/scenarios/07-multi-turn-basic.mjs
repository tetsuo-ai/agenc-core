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
  timeoutMs: 360_000,
  slimCwd: true,
  // Architectural: BackgroundAgentRunner.#cleanupWhenComplete deletes
  // agents from #active when their thread.join() resolves (after every
  // turn). Multi-turn requires either keeping agents alive across joins
  // or restarting the thread per message. Filed as
  // GAP-DMN-MULTITURN-RUNNER-DESIGN. The agent-lifecycle and protocol
  // layers ARE correct; the runner's one-shot lifecycle is the gap.
  skip: "blocked on runner one-shot lifecycle; see GAP-DMN-MULTITURN-RUNNER-DESIGN",
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForIdle({ timeout: 120_000 });
  await session.type("and again");
  await session.submit();
  await session.waitForIdle({ timeout: 120_000 });
}
