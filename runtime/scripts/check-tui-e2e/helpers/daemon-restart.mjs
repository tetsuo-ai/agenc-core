/**
 * Shared steps for scenarios that restart the daemon under an open TUI and
 * submit right away, while the persistent client is still reconnecting.
 */
import {
  frameLooksBusy,
  hasRenderedAssistantReply,
  renderPtyRows,
} from "../harness.mjs";

const OUTCOME_TIMEOUT_MS = 60_000;
// Longer than the delay before the busy byline appears, so a working line
// that never ends is seen as busy inside this window.
const SETTLED_WINDOW_MS = 4_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start the TUI, finish one turn, then restart the daemon under it. */
export async function restartDaemonAfterFirstTurn(session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForAssistantReply({ timeout: 60_000 });
  await session.waitForIdle({ timeout: 60_000 });
  // Same operation an upgrade script or `agenc daemon restart` performs.
  await session.restartGateDaemon();
}

/**
 * Submit `text` and wait until it settles: a rendered reply or the
 * "Submission failed" notice, then a frame that stays out of the busy state.
 * Bytes-stopped idle detection alone cannot prove this: before the busy
 * byline ("esc to interrupt") appears, a stuck working line looks idle.
 */
export async function submitAndWaitForOutcome(session, text) {
  await session.type(text);
  await session.submit();
  const submittedAt = session.watermark;
  const start = Date.now();
  let outcome = null;
  let quietSince = null;
  while (Date.now() - start < OUTCOME_TIMEOUT_MS) {
    session.throwIfAborted();
    if (session.exited) {
      throw new Error(`TUI exited before "${text}" settled`);
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
      ? `"${text}" showed neither a reply nor a "Submission failed" notice within ${OUTCOME_TIMEOUT_MS}ms`
      : `"${text}" (${outcome}) left the TUI busy ("esc to interrupt") within ${OUTCOME_TIMEOUT_MS}ms`,
  );
}

/** No unhandled error or stack trace reached the terminal. */
export function assertNoUnhandledError(session) {
  if (/Error:|UnhandledPromiseRejection|at Object\.request/.test(session.text)) {
    throw new Error("TUI emitted unhandled error during daemon-restart recovery");
  }
}
