/**
 * Tab on empty input scenario.
 *
 * Pressing Tab on an empty input should not crash. May open a
 * suggestion picker or be a no-op. Either is acceptable.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "Tab on empty input does not crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  session.send("\t");
  await sleep(800);
  // If a picker opened, dismiss.
  session.sendEscape();
  await sleep(300);
}
