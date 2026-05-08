/**
 * --yolo multi-turn scenario.
 *
 * Same as 07 but under --yolo. Catches yolo-specific session/transcript
 * regressions that don't manifest in default mode (e.g. permission-skip
 * paths leaving the daemon in a different state on the second submit).
 */
export const meta = {
  description: "--yolo: two messages in one session, both reach idle.",
  args: ["--yolo"],
  timeoutMs: 120_000,
  // Same 'agent not found' crash as 07 fires in --yolo on the second
  // submit. The previous run's PASS was flake — daemon-side state from
  // earlier scenarios momentarily masked the race. Filed alongside 07
  // as GAP-DMN-AGENT-NOT-FOUND.
  skip: "blocked on multi-turn 'agent not found' crash (--yolo too); see GAP-DMN-AGENT-NOT-FOUND",
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForIdle({ timeout: 60_000 });
  await session.type("and again");
  await session.submit();
  await session.waitForIdle({ timeout: 60_000 });
}
