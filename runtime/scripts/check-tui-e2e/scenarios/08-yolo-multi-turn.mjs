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
  timeoutMs: 360_000,
  slimCwd: true,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForIdle({ timeout: 120_000 });
  await session.type("and again");
  await session.submit();
  await session.waitForIdle({ timeout: 120_000 });
}
