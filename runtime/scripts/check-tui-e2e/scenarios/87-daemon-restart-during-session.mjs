/**
 * Daemon restart during an open TUI session.
 *
 * The user opens agenc, finishes a turn, the daemon restarts (crashed,
 * upgraded, or another tool ran `daemon restart`), and the user submits
 * again while the TUI's persistent client is still reconnecting.
 *
 * This client sets no API key, so the restarted daemon restores the session
 * with a live runtime. The TUI attaches to it again and takes the daemon's
 * settings, so the submission made during the reconnect gets its reply, and
 * so does the next one. Before, the first hung on a working line that never
 * ended, and once that was fixed it failed with "re-attach is required" and
 * every later prompt failed the same way. Scenario 145 covers a session the
 * daemon cannot restore on its own.
 */
import { waitForFrameText } from "../helpers/frame.mjs";
import {
  assertNoUnhandledError,
  restartDaemonAfterFirstTurn,
  submitAndWaitForOutcome,
} from "../helpers/daemon-restart.mjs";

export const meta = {
  description:
    "TUI attaches again after a daemon restart and keeps answering.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  env: { OPENAI_COMPATIBLE_API_KEY: "" },
  timeoutMs: 240_000,
  slimCwd: true,
};

export default async function (session) {
  await restartDaemonAfterFirstTurn(session);

  // Submit right away, while the persistent client is still reconnecting.
  const first = await submitAndWaitForOutcome(session, "and again");
  if (first !== "reply") {
    throw new Error(
      `the submission made during the reconnect ended as "${first}", not a reply`,
    );
  }
  await waitForFrameText(
    session,
    /daemon reconnected/u,
    "reconnected notice",
    5_000,
  );

  // The session keeps working after the restart.
  const second = await submitAndWaitForOutcome(session, "one more");
  if (second !== "reply") {
    throw new Error(`the next submission ended as "${second}", not a reply`);
  }
  await session.waitForIdle({ timeout: 15_000 });
  assertNoUnhandledError(session);
}
