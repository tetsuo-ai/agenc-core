/**
 * Safety regression: a --yolo token inside an argv prompt must stay prompt
 * text. The real PTY starts the prompt turn immediately; default permission
 * mode must stop the mock model's Bash request at the approval overlay.
 */
const marker = "agenc-prompt-yolo-must-not-run-98";

export const meta = {
  description: "Prompt text containing --yolo cannot bypass tool approval.",
  args: [
    "Use",
    "the",
    "Bash",
    "tool",
    "to",
    "run:",
    "echo",
    marker,
    "--yolo",
  ],
  timeoutMs: 60_000,
  slimCwd: true,
  sandboxMode: "danger-full-access",
};

export default async function (session) {
  await session.start();
  await session.waitForPermissionOverlay({ timeout: 45_000 });
  await session.denyPermissionOverlay();
}
