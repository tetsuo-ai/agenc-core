/**
 * Permission overlay "always allow" scenario.
 *
 * Default mode. Triggers Bash, hits the overlay, sends "2\\r" to accept
 * + record "always allow for this tool/path". The harness uses temp
 * HOME isolation so the policy entry doesn't leak.
 *
 * Uses a SLIM cwd (mkdtemp under /tmp with a single trivial file) so
 * the daemon's project-context auto-load doesn't bloat the token
 * budget. With agenc-core's runtime/ as cwd, AGENC.md and surrounding
 * files pushed >237k tokens and starved compaction; in /tmp/<empty>
 * the budget fits comfortably.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const slimCwd = mkdtempSync(path.join(tmpdir(), "agenc-tui-e2e-slim-"));
writeFileSync(path.join(slimCwd, "README.md"), "test cwd\n", "utf8");

export const meta = {
  description: "Permission overlay (default mode): always-allow runs the tool.",
  timeoutMs: 120_000,
  useTempHome: true,
  cwd: slimCwd,
  // 31-permission-accept and 32-permission-deny verify the overlay
  // path. 33's always-allow exercise needs the model to actually
  // re-run the tool after the policy update, which has the same
  // model-perf ceiling as the yolo-tool round-trips.
  skip: "model perf ceiling on always-allow re-execution",
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
