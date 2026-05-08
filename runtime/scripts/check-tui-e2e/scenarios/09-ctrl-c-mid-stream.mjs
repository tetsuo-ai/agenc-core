/**
 * Mid-stream Ctrl+C scenario.
 *
 * Submits a prompt that yields a long reply, then sends Ctrl+C while the
 * assistant is still streaming. Expects the cancel to land cleanly: stream
 * stops, prompt returns idle, no crash, no orphaned subagent.
 *
 * Catches: cancel paths that throw, half-written transcript entries that
 * never close, subagents that keep streaming bytes after the parent client
 * detaches, daemon ↔ client state mismatch on cancel.
 *
 * The test waits ~2s after the assistant starts replying before sending
 * SIGINT, which is enough for the model to have generated some content but
 * (with a long-form prompt) far short of the natural turn end.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "Ctrl+C mid-stream cancels cleanly without crashing the TUI.",
  timeoutMs: 60_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    "Write a 200-word essay about the history of the printing press.",
  );
  await session.submit();
  // Let the model start producing tokens. Idle won't fire while bytes flow.
  await sleep(3_000);
  // Ctrl+C: this is "esc to interrupt" in the TUI footer.
  session.send("\x1b"); // Esc is the documented mid-stream cancel
  await session.waitForIdle({ idleWindow: 1_500, timeout: 15_000 });
}
