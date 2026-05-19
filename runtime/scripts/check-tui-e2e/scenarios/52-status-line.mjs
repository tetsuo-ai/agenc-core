/**
 * Footer status line scenario.
 *
 * The TUI footer shows model + provider + percentage + helpful hints.
 * After cold start the line should include the configured model name.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "Footer status line includes the configured model name.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await sleep(500);
  // Configured model is qwen3.6-35b-a3b-fp8 — its short name should
  // appear in the title/footer somewhere.
  if (!/qwen/i.test(session.text)) {
    throw new Error(
      `footer/title doesn't mention configured model 'qwen'; captured: ${session.text.slice(-300)}`,
    );
  }
}
