/**
 * --dangerously-bypass-approvals-and-sandbox multi-turn scenario.
 *
 * Same as 07 but under --dangerously-bypass-approvals-and-sandbox. Catches yolo-specific session/transcript
 * regressions that don't manifest in default mode (e.g. permission-skip
 * paths leaving the daemon in a different state on the second submit).
 */
export const meta = {
  description: "--dangerously-bypass-approvals-and-sandbox: two messages in one session, both reach idle.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
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
