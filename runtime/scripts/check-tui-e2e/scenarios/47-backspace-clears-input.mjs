/**
 * Backspace input scenario.
 *
 * Type text, press Backspace several times, verify input visibly
 * shrinks. The text-rendering harness can't easily inspect the input
 * box state directly; instead we type "hello", backspace 5 times,
 * then submit empty. Should be a no-op (verified by 46).
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "Backspace clears typed input; final submit is no-op.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hello");
  await sleep(150);
  for (let i = 0; i < 5; i += 1) {
    session.send("\x7f"); // Backspace (DEL char, conventional in terminals)
    await sleep(50);
  }
  await sleep(300);
  session.send("\r");
  await sleep(1_500);
  // Empty submit — no model invocation. No crash.
}
