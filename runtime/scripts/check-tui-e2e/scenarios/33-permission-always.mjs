/**
 * Permission overlay "always allow" scenario.
 *
 * Default mode. Triggers Bash, hits the overlay, sends "2" to accept
 * for the current session. The harness uses temp HOME isolation so the
 * session-scoped policy entry doesn't leak.
 *
 * Uses a SLIM cwd (mkdtemp under /tmp with a single trivial file) so
 * the daemon's project-context auto-load doesn't bloat the token
 * budget. With agenc-core's runtime/ as cwd, AGENC.md and surrounding
 * files pushed >237k tokens and starved compaction; in /tmp/<empty>
 * the budget fits comfortably.
 *
 * The assertion reads the temp HOME rollout so it proves Bash actually
 * completed without depending on the model echoing stdout in its final
 * assistant message.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const slimCwd = mkdtempSync(path.join(tmpdir(), "agenc-tui-e2e-always-"));
writeFileSync(path.join(slimCwd, "README.md"), "permission always cwd\n", "utf8");
writeFileSync(path.join(slimCwd, "package.json"), '{"private":true}\n', "utf8");

const marker = "agenc-permission-always-marker-bc42";
const prompt = [
  "Use the Bash tool to run exactly:",
  `printf '%s\\n' ${shellQuote(marker)}`,
].join(" ");

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const meta = {
  description: "Permission overlay (default mode): session approval runs the tool.",
  timeoutMs: 120_000,
  useTempHome: true,
  sandboxMode: "danger-full-access",
  args: ["--permission-mode", "default"],
  cwd: slimCwd,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(prompt);
  await session.submit();
  await session.waitForPermissionOverlay({ timeout: 60_000 });
  await session.alwaysAllowPermissionOverlay();
  await session.waitForIdle({ idleWindow: 4_000, timeout: 90_000 });
  await session.assertRolloutToolOutput(marker, { label: "session-approved Bash output" });
}
