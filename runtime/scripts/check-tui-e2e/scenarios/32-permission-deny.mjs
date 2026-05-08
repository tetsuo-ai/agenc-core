/**
 * Permission overlay deny scenario.
 *
 * Default mode. Triggers Bash, hits the overlay, sends "3\\r" to reject.
 * The unique echo marker MUST NOT appear in the output (Bash must not
 * have run). The TUI should return to idle after a brief assistant
 * acknowledgement of the rejection.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "Permission overlay (default mode): deny path blocks the tool.",
  timeoutMs: 90_000,
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
  // Sanity wait — even if a delayed tool execution happened, we'd see the
  // marker arriving up to 2s after idle.
  await sleep(2_000);
  if (/agenc-permission-deny-marker-fe17/.test(session.text)) {
    throw new Error(
      "deny path leaked: bash command output appeared despite reject",
    );
  }
}
