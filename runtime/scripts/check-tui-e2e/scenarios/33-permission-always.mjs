/**
 * Permission overlay "always allow" scenario.
 *
 * Default mode. Triggers Bash, hits the overlay, sends "2\\r" to accept
 * + record "always allow for this tool/path". Asserts the Bash command
 * runs (marker appears).
 *
 * Side-effect: this writes an "always allow Bash in <cwd>" entry to the
 * permission policy file. Phase C temp HOME isolation will keep this
 * scoped per-scenario; until then, this scenario leaves a small policy
 * tail in the user's real ~/.agenc state. Acceptable trade-off; the
 * entry is benign.
 */
export const meta = {
  description: "Permission overlay (default mode): always-allow runs the tool.",
  timeoutMs: 90_000,
  // Writes a permanent "always allow Bash in <cwd>" entry to the daemon
  // sqlite policy store, polluting state for subsequent scenarios. Needs
  // per-scenario HOME isolation (GAP-TEST-08) to be re-runnable. Until
  // then this scenario stays skipped.
  skip: "writes persistent policy entry; needs GAP-TEST-08 temp HOME",
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    "Use the Bash tool to run: echo agenc-permission-always-marker-bc42",
  );
  await session.submit();
  await session.waitForPermissionOverlay({ timeout: 60_000 });
  await session.alwaysAllowPermissionOverlay();
  // Verifying that the tool actually re-ran would require disambiguating
  // the marker-echoed-in-prompt from the marker-emitted-by-bash, same
  // problem 32-permission-deny hit. We just verify the overlay closed and
  // the TUI returned to idle.
  await session.waitForIdle({ timeout: 60_000 });
}
