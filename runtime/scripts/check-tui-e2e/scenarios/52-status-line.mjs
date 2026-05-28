/**
 * Terminal status scenario.
 *
 * The terminal title shows the configured provider/model on cold start.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECTED_PROVIDER = "grok";
const EXPECTED_MODEL = "grok-4.20-0309-non-reasoning";
const EXPECTED_TITLE = `AgenC ${EXPECTED_PROVIDER}/${EXPECTED_MODEL}`;

export const meta = {
  description: "Terminal title includes the configured model name.",
  args: ["--provider", EXPECTED_PROVIDER, "--model", EXPECTED_MODEL],
  timeoutMs: 30_000,
};

function terminalTitles(raw) {
  return Array.from(
    raw.matchAll(/\x1b\](?:0|2);([\s\S]*?)(?:\x07|\x1b\\)/g),
    (match) => match[1] ?? "",
  );
}

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await sleep(500);
  const titles = terminalTitles(session.raw);
  if (!titles.some((title) => title.includes(EXPECTED_TITLE))) {
    throw new Error(
      `terminal title doesn't mention configured provider/model '${EXPECTED_TITLE}'; titles: ${titles.join(" | ") || "(none)"}; latest frame: ${session.latestFrame.slice(-300)}`,
    );
  }
}
