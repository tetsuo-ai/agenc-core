/**
 * Yolo + Grep tool round-trip.
 *
 * Asks the model to grep a unique pattern from /etc/os-release. The pattern
 * "PRETTY_NAME" appears in /etc/os-release on Ubuntu/Debian/Pop! variants;
 * we assert the matched line shows up in the transcript.
 */
export const meta = {
  description: "--yolo: model uses Grep, matched line renders in transcript.",
  args: ["--yolo"],
  timeoutMs: 90_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    "Use the Grep tool to search /etc/os-release for the pattern 'PRETTY_NAME'.",
  );
  await session.submit();
  await session.waitFor(/PRETTY_NAME/, {
    timeout: 60_000,
    label: "grep match",
  });
  await session.waitForIdle({ timeout: 30_000 });
}
