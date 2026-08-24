/**
 * --dangerously-bypass-approvals-and-sandbox cold-start scenario.
 *
 * Same as 01 but with --dangerously-bypass-approvals-and-sandbox. Catches yolo-specific cold-start regressions
 * (permission-mode init, footer glyph drift, trust dialog interaction).
 */
export const meta = {
  description: "Cold start under --dangerously-bypass-approvals-and-sandbox to first idle.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
}
