/**
 * /clear scenario.
 *
 * Submits a turn so the transcript has content, then sends `/clear` and
 * expects the prompt to return idle without a crash. The GAP-TUI-03 fix
 * landed daemon-side history clearing plus a transcript-reset event; this
 * scenario verifies the wire path stays connected.
 *
 * Note: we don't yet snapshot the rendered transcript to confirm the
 * messages disappeared visually. That requires a screen-state inspector
 * the harness doesn't have today. For Phase A we assert the slash command
 * runs cleanly and the prompt returns.
 */
export const meta = {
  description: "Submit a turn, then /clear; expect idle prompt and no crash.",
  // This is a transcript-reset contract, independent of platform sandbox
  // availability on the gate host.
  args: ["--yolo"],
  slimCwd: true,
  timeoutMs: 90_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForAssistantReply({ timeout: 45_000 });
  await session.waitForPrompt({ timeout: 30_000 });
  await session.submitSlashCommand("/clear");
  await session.waitForPrompt({ timeout: 10_000 });
}
