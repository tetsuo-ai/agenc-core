/**
 * Safety regression: `--` ends startup option parsing. Permission-looking
 * tokens after it are prompt text and cannot select bypassPermissions.
 */
const marker = "agenc-delimited-permission-mode-must-not-run-99";

export const meta = {
  description: "Tokens after -- cannot select bypassPermissions.",
  args: [
    "--",
    "Use",
    "the",
    "Bash",
    "tool",
    "to",
    "run:",
    "echo",
    marker,
    "--permission-mode",
    "bypassPermissions",
  ],
  timeoutMs: 60_000,
  slimCwd: true,
  useTempHome: true,
  sandboxMode: "danger-full-access",
};

export default async function (session) {
  await session.start();
  await session.waitForPermissionOverlay({ timeout: 45_000 });
  await session.denyPermissionOverlay();
}
