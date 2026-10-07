/**
 * A headless continue issued while the restarted daemon is still restoring
 * the session attaches to the restored agent.
 *
 * Guards a fixed failure: `agenc --continue -p` sent right after a daemon
 * restart found no agent, because `agent.list` answers before startup
 * restores finish. Its cold resume then waited for the restore, got
 * CANONICAL_SESSION_ALREADY_ACTIVE, and exited 1 with "canonical session ...
 * already has a live daemon agent", because the one-shot daemon client threw
 * a plain Error without the code the resume path checks.
 *
 * The continue starts as soon as the new daemon answers `daemon status`. The
 * restore takes about 2 s in the gate, so it is normally still running. The
 * client sets no API key, so the session comes back with a live runtime, which
 * is the case that answers CANONICAL_SESSION_ALREADY_ACTIVE.
 */
export const meta = {
  description: "A headless continue during startup restores attaches to the restored agent.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  env: { OPENAI_COMPATIBLE_API_KEY: "" },
  timeoutMs: 180_000,
  slimCwd: true,
};

const PROMPT = "and again";
const RESTORE_SUMMARY = /daemon restored \d+ session\(s\) open at its last shutdown/u;

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForAssistantReply({ timeout: 60_000 });
  await session.waitForIdle({ timeout: 60_000 });

  const pid = await session.restartGateDaemon();
  const daemon = session.gateState.daemonProcesses.get(pid);
  const restoredBeforeContinue = RESTORE_SUMMARY.test(daemon?.stderr ?? "");
  const result = await session.runAgenc(
    ["--dangerously-bypass-approvals-and-sandbox", "--continue", "-p", PROMPT],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0 || result.stdout.trim().length === 0) {
    throw new Error(
      `headless continue exited ${result.code} with stdout ${JSON.stringify(result.stdout)} ` +
        `(restore settled before it started: ${restoredBeforeContinue}); stderr: ${result.stderr.slice(0, 600)}`,
    );
  }

  // The turn ran in the one restored session, not in a second resume of it.
  const items = await session.readRolloutItems();
  const sessions = new Set(
    items.filter((item) => item?.type === "session_meta").map((item) => item.payload?.sessionId),
  );
  const events = items.map((item) => item?.payload?.msg).filter(Boolean);
  const prompted = events.findIndex(
    (msg) => msg.type === "user_message" && msg.payload?.message === PROMPT,
  );
  if (
    sessions.size !== 1 ||
    prompted < 0 ||
    !events.slice(prompted).some((msg) => msg.type === "turn_complete")
  ) {
    throw new Error(
      `expected one session with a completed ${JSON.stringify(PROMPT)} turn; ` +
        `sessions ${JSON.stringify([...sessions])}, prompt at ${prompted}`,
    );
  }
}
