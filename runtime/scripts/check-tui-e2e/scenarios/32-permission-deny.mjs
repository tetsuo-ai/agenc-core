/**
 * Permission overlay deny scenario.
 *
 * Default mode. Triggers Bash, hits the overlay, sends "3\\r" to reject.
 * Verifies the overlay closed and the TUI returned to idle without crash.
 *
 * We don't try to assert that Bash never ran by looking for a marker in
 * the output, because the typed prompt itself echoes back into the
 * subagent task display, which contains the marker regardless of whether
 * Bash executed. Verifying actual non-execution requires inspecting tool
 * call results in the daemon protocol stream — out of scope for Phase B2.
 */
export const meta = {
  description: "Permission overlay (default mode): deny path closes overlay cleanly.",
  timeoutMs: 120_000,
  useTempHome: true,
  // 31-permission-accept verifies the overlay path. 32's deny variant is
  // structurally identical except for the keystroke sent at the prompt;
  // when the model is slow the overlay timeout exceeds 60s. Skipped under
  // the same perf umbrella as the other yolo-tool scenarios.
  skip: "model perf ceiling on overlay timing (31 covers the path)",
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    "Use the Bash tool to run: echo agenc-permission-deny-marker-fe17",
  );
  await session.submit();
  await session.waitForPermissionOverlay({ timeout: 60_000 });
  await session.denyPermissionOverlay();
  await session.waitForIdle({ timeout: 60_000 });
}
