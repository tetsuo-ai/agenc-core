/**
 * Help open + dismiss scenario.
 *
 * Press `?` to open the inline help menu, then Esc to dismiss. Verifies
 * the help-menu shortcut works and exits cleanly. The footer shows
 * "? for shortcuts" by default — this exercises that path.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "? opens shortcut help menu; Esc closes it.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  session.send("?");
  await sleep(500);
  session.sendEscape();
  await sleep(300);
}
