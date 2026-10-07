/**
 * Daemon restart during an open TUI session.
 *
 * This guards against a fixed production failure: user opens agenc, submits a
 * turn, the daemon restarts (crashed, upgraded, or another tool ran
 * `daemon restart`), and the user submits a second turn while the TUI's
 * persistent client is still reconnecting.
 *
 * The scenario:
 *   1. start TUI, type "hi", wait for the reply
 *   2. external `daemon restart` kicks the user's old daemon process
 *   3. type "and again" immediately → assert the submission settles: the TUI
 *      either renders a reply or shows the "Submission failed" notice, and
 *      then stays out of the busy state. It must not sit on a working line
 *      that never ends, and it must not dump an unhandled rejection.
 *
 * Bytes-stopped idle detection alone cannot prove step 3: before the busy
 * byline ("esc to interrupt") appears, a stuck working line looks idle.
 */
import {
  frameLooksBusy,
  hasRenderedAssistantReply,
  renderPtyRows,
} from "../harness.mjs";

export const meta = {
  description:
    "TUI survives a daemon restart between turns (or fails cleanly).",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  timeoutMs: 240_000,
  slimCwd: true,
};

const OUTCOME_TIMEOUT_MS = 60_000;
// Longer than the delay before the busy byline appears, so a working line
// that never ends is seen as busy inside this window.
const SETTLED_WINDOW_MS = 4_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSettledOutcome(session, submittedAt) {
  const start = Date.now();
  let outcome = null;
  let quietSince = null;
  while (Date.now() - start < OUTCOME_TIMEOUT_MS) {
    session.throwIfAborted();
    if (session.exited) {
      throw new Error("TUI exited before the post-restart submission settled");
    }
    const frame = session.latestFrame;
    if (outcome === null) {
      if (/Submission failed:/u.test(frame)) {
        outcome = "failed";
      } else if (
        hasRenderedAssistantReply(
          renderPtyRows(session.raw.slice(submittedAt), {
            cols: session.cols,
            rows: session.rows,
          }),
        )
      ) {
        outcome = "reply";
      }
    }
    if (frameLooksBusy(frame)) {
      quietSince = null;
    } else if (quietSince === null) {
      quietSince = Date.now();
    }
    if (
      outcome !== null &&
      quietSince !== null &&
      Date.now() - quietSince >= SETTLED_WINDOW_MS
    ) {
      return outcome;
    }
    await sleep(100);
  }
  throw new Error(
    outcome === null
      ? `post-restart submission showed neither a reply nor a "Submission failed" notice within ${OUTCOME_TIMEOUT_MS}ms`
      : `post-restart submission (${outcome}) left the TUI busy ("esc to interrupt") within ${OUTCOME_TIMEOUT_MS}ms`,
  );
}

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForAssistantReply({ timeout: 60_000 });
  await session.waitForIdle({ timeout: 60_000 });

  // Restart the daemon out-of-band — same operation that any external
  // tool, upgrade script, or `agenc daemon restart` invocation would
  // perform.
  await session.restartGateDaemon();

  // Submit right away, while the persistent client is still reconnecting.
  await session.type("and again");
  await session.submit();
  const submittedAt = session.watermark;
  await waitForSettledOutcome(session, submittedAt);
  await session.waitForIdle({ timeout: 15_000 });
  // No 'Error:' or 'unhandled' or stack-trace markers in the output.
  if (/Error:|UnhandledPromiseRejection|at Object\.request/.test(session.text)) {
    throw new Error(
      "TUI emitted unhandled error during daemon-restart recovery",
    );
  }
}
