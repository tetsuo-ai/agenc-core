export const meta = {
  description: "long unbroken prompt input wraps inside the prompt box",
  args: ["--yolo"],
  useTempHome: true,
  timeoutMs: 30_000,
};

export default async function run(session) {
  await session.start();
  await session.waitForPrompt({ idleWindow: 800, timeout: 10_000 });

  const input = "a".repeat(260);
  await session.type(input, { perCharMs: 1 });
  await session.waitForIdle({ idleWindow: 800, timeout: 10_000 });

  const inputLines = session.latestFrame
    .split("\n")
    .filter((line) => /a{10}/.test(line));

  if (inputLines.length < 2) {
    throw new Error(
      `expected long token input to wrap across prompt lines, got ${inputLines.length}: ${JSON.stringify(inputLines)}`,
    );
  }

  const truncatedLine = inputLines.find((line) => line.includes("\u2026"));
  if (truncatedLine !== undefined) {
    throw new Error(`long token input was truncated: ${truncatedLine}`);
  }
}
