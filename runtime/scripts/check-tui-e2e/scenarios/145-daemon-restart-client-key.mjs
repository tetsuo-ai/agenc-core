/**
 * Daemon restart under a TUI whose provider key only the client holds.
 *
 * The daemon never writes credentials to disk, so after a restart it brings
 * this session back without a runtime and leaves it for the client to
 * resume (see scenario 142). The open TUI cannot attach to it again. A
 * submission made during the reconnect must fail promptly with what to do
 * next, never sit on a working line, and the TUI must stay usable.
 */
import {
  assertNoUnhandledError,
  restartDaemonAfterFirstTurn,
  submitAndWaitForOutcome,
} from "../helpers/daemon-restart.mjs";

export const meta = {
  description:
    "After a daemon restart that cannot restore the session, the TUI says how to resume it.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  timeoutMs: 240_000,
  slimCwd: true,
};

const HINT =
  /Submission failed: the daemon restarted and could not bring this session back; quit and run agenc --continue to pick it up/u;

export default async function (session) {
  await restartDaemonAfterFirstTurn(session);

  const outcome = await submitAndWaitForOutcome(session, "and again");
  if (outcome !== "failed") {
    throw new Error(`expected the submission to fail with a hint, got "${outcome}"`);
  }
  if (!HINT.test(session.latestFrame)) {
    throw new Error(
      `the failure does not say how to resume: ${session.latestFrame.slice(-800)}`,
    );
  }
  await session.waitForIdle({ timeout: 15_000 });
  assertNoUnhandledError(session);
}
