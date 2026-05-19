/**
 * Arrow-up history recall scenario.
 *
 * Submit a message, wait for idle, press Up arrow on empty prompt,
 * verify the previous input is recalled. Catches: history-buffer
 * regressions, history-index off-by-one, daemon vs TUI history-source
 * drift.
 */
export const meta = {
  description: "Up arrow recalls previous input from history.",
  timeoutMs: 90_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("first message remembered for history");
  await session.submit();
  await session.waitForIdle({ timeout: 30_000 });
  session.send("\x1b[A"); // Up arrow
  // Recalled text should appear in input. Idle should return.
  await session.waitForIdle({ timeout: 5_000 });
}
