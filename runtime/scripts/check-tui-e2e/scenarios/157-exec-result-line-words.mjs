/**
 * Shell result rows say what happened in words, never the model's footer.
 *
 * Owner report (2026-11-14, W10 screenshot): after "Ran sleep 4; echo done" the
 * row under it read "[exec yielded=true wall_time=1.0030s tokens=0
 * session_id=1]". That footer is metadata for the model. The row now reads
 * "still running · 1s" for a command still running when the call returned,
 * shows the output of a command that printed something, and "no output" for
 * one that printed nothing. No "[exec" text may reach the screen.
 */
import { frameText, waitForFrameText } from "../helpers/frame.mjs";

export const meta = {
  description: "Shell result rows: still running, real output and no output, never the [exec ...] footer.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  timeoutMs: 180_000,
};

const OUTPUT_MARKER = "exec-footer-output-7c41";

async function runTool(session, command, label) {
  await session.submit(`Use the Bash tool to run exactly: ${command}`);
  await session.waitFor(/tool complete/u, { timeout: 60_000, label });
  await session.waitForIdle({ idleWindow: 1_500, timeout: 30_000 });
}

function assertNoFooter(session, label) {
  const screen = frameText(session);
  if (/\[exec\b/u.test(screen) || /yielded=|wall_time=|session_id=/u.test(screen)) {
    throw new Error(`${label}: the exec footer reached the screen:\n${screen}`);
  }
}

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });

  // 1. A finished command that printed a line: the line itself.
  await runTool(session, `echo ${OUTPUT_MARKER}`, "command with output");
  await waitForFrameText(session, new RegExp(`└\\s+${OUTPUT_MARKER}`, "u"), "the output result line");
  assertNoFooter(session, "command with output");

  // 2. A finished command that printed nothing: the quiet "no output".
  await runTool(session, "true", "command without output");
  await waitForFrameText(session, /└\s+no output/u, "the no-output result line");
  assertNoFooter(session, "command without output");

  // 3. Still running when the call returned: the yield window is shorter than
  //    the sleep, so the runtime hands back a running session. This runs last:
  //    once that session ends, the runtime adds a notice to the next message,
  //    which this gate model would read as part of a command.
  await runTool(session, "sleep 4; echo done", "yielded command");
  await waitForFrameText(session, /still running · \d+s/u, "the still-running result line");
  assertNoFooter(session, "yielded command");
}
