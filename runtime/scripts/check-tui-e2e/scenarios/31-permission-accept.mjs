/**
 * Permission overlay accept scenario.
 *
 * Default mode (no --yolo). Submits a prompt that triggers Bash. Default
 * policy prompts: "Do you want to proceed? 1. Yes / 2. Yes, always / 3. No".
 * The harness sends "1\\r" to accept, then asserts the Bash command output
 * appears.
 */
export const meta = {
  description: "Permission overlay (default mode): accept path runs the tool.",
  timeoutMs: 90_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    "Use the Bash tool to run: echo agenc-permission-accept-marker-3a9c",
  );
  await session.submit();
  await session.waitForPermissionOverlay({ timeout: 60_000 });
  await session.acceptPermissionOverlay();
  await session.waitFor(/agenc-permission-accept-marker-3a9c/, {
    timeout: 60_000,
    label: "bash output after accept",
  });
  await session.waitForIdle({ timeout: 30_000 });
}
