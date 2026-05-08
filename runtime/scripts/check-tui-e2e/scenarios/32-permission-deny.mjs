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
  timeoutMs: 90_000,
  // 33-permission-always wrote a persistent "always allow Bash in
  // agenc-core/runtime" entry into the daemon's sqlite policy store; the
  // entry survives daemon restart and suppresses the overlay this
  // scenario depends on. Reliable test requires per-scenario HOME
  // isolation (GAP-TEST-08) to keep policy state scoped. Until then
  // both 32 and 33 are skipped together.
  skip: "blocked on policy persistence pollution from 33-always; needs GAP-TEST-08 temp HOME",
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
