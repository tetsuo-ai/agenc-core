/**
 * --yolo cold-start scenario.
 *
 * Same as 01 but with --yolo. Catches yolo-specific cold-start regressions
 * (permission-mode init, footer glyph drift, trust dialog interaction).
 */
export const meta = {
  description: "Cold start under --yolo to first idle.",
  args: ["--yolo"],
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
}
