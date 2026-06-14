/**
 * Ctrl+D shutdown scenario.
 *
 * Sends Ctrl+D on an empty input and expects the TUI to shut down
 * cleanly within a short grace window. Catches: shutdown handlers that
 * throw, daemon-detach paths that hang, transcript-flush logic that loops.
 *
 * Why not /exit: the slash typeahead picker keeps /exit-worktree
 * highlighted after typing /exit exactly, so pressing Enter accepts the
 * wrong command. That is a real TUI usability gap (typed exact match
 * should win the highlight) but it is out of scope for this gate. Ctrl+D
 * is the more fundamental shutdown signal anyway — bypasses the slash
 * machinery entirely.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Send the CSI-u Ctrl+D encoding so node-pty delivers a key event instead of
// letting the pseudo-terminal line discipline treat raw \x04 as EOF.
const CTRL_D = "\x1b[100;5u";

export const meta = {
  description: "Ctrl+D twice triggers clean shutdown of the TUI.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ idleWindow: 2500, timeout: 15_000 });
  // First Ctrl+D arms the exit confirmation ("Press Ctrl-D again to exit").
  // The second Ctrl+D actually shuts down. The two-press requirement is a
  // safety guard: a single accidental Ctrl+D mid-conversation should not
  // throw away the session.
  session.send(CTRL_D);
  await session.waitFor(/same key again to exit/i, {
    timeout: 4_000,
    label: "Ctrl+D exit confirmation",
  });
  await sleep(100);
  session.send(CTRL_D);
  const start = Date.now();
  while (Date.now() - start < 8_000) {
    if (session.exited) return;
    await sleep(100);
  }
  throw new Error("Ctrl+D x2 did not cause the TUI to terminate within 8s");
}
