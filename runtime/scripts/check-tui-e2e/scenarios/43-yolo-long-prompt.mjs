/**
 * Long-prompt scenario.
 *
 * Submits a prompt with substantial text (~500 chars). Catches: input
 * buffer overflow, prompt-clipping, transcript-render bugs on long
 * input, daemon protocol payload limits.
 */
export const meta = {
  description: "--yolo: ~500 char prompt submitted without truncation or crash.",
  args: ["--yolo"],
  timeoutMs: 90_000,
};

const longPrompt =
  "I have a long question for you. " +
  "First, please briefly tell me what AgenC is. " +
  "Second, what makes a good CLI tool. " +
  "Third, summarize your answer in two short sentences. " +
  "Fourth, do not run any tools. Fifth, end with the literal string DONE-MARKER-XYZ. ";

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(longPrompt);
  await session.submit();
  await session.waitFor(/DONE-MARKER-XYZ/, {
    timeout: 75_000,
    label: "long-prompt completion marker",
  });
  await session.waitForIdle({ timeout: 30_000 });
}
