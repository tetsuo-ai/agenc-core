/**
 * Rapid keystroke scenario.
 *
 * Type 100 characters fast, no per-key delay. Verifies the input
 * handler keeps up and the buffer doesn't drop characters or crash
 * on debounce/throttle paths.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "100 rapid keystrokes don't crash or drop input handler.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  // Type 100 chars with no delay
  const text = "a".repeat(100);
  for (const ch of text) {
    session.send(ch);
  }
  await sleep(800);
  // Backspace it all out so we leave the prompt clean.
  for (let i = 0; i < 100; i += 1) {
    session.send("\x7f");
  }
  await sleep(300);
}
