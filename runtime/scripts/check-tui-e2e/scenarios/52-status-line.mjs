/**
 * Footer status line scenario.
 *
 * The terminal title shows the configured provider/model on cold start.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "Terminal title includes the configured model name.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await sleep(500);
  // Configured model is qwen3.6-35b-a3b-fp8 — its short name appears in
  // the OSC title, not necessarily in the latest rendered workbench frame.
  if (!/qwen/i.test(session.plainText)) {
    throw new Error(
      `terminal title doesn't mention configured model 'qwen'; captured: ${session.plainText.slice(-300)}`,
    );
  }
}
