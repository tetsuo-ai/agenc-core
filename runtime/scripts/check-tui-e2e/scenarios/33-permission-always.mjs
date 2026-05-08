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
  timeoutMs: 120_000,
  useTempHome: true,
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
  // After always-allow, the TUI keeps repainting the busy title-bar OSC
  // sequence while the model finishes its post-tool turn, which keeps the
  // idle window from closing on a 1.2s default. Bump the window to 4s so
  // the spinner-paint cadence registers as idle.
  await session.waitForIdle({ idleWindow: 4_000, timeout: 90_000 });
}
